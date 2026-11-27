// ============================================================
// FRIDAY — Shared Type Definitions
// Central type system used across all layers
// ============================================================

/** Unique identifier for tasks, sessions, and memory entries */
export type FridayId = string;

/** Risk classification for any action FRIDAY might take */
export enum RiskLevel {
  LOW = 'low',       // Read-only, informational — auto-execute
  MEDIUM = 'medium', // Write operations, app control — execute + audit
  HIGH = 'high',     // Destructive, external comms — require approval
}

/** The structured result of intent parsing */
export interface Intent {
  /** Unique identifier for this intent */
  id: FridayId;
  /** Raw text from user */
  rawInput: string;
  /** Classified action type */
  action: ActionType;
  /** Extracted parameters */
  params: Record<string, string>;
  /** Confidence score 0-1 */
  confidence: number;
  /** Risk classification */
  risk: RiskLevel;
  /** ISO timestamp */
  timestamp: string;
  /** Additional context from memory */
  context?: IntentContext;
}

/** High-level categories of actions FRIDAY can perform */
export enum ActionType {
  // Claw-delegated actions
  CODE_TASK = 'code_task',
  FILE_READ = 'file_read',
  FILE_WRITE = 'file_write',
  FILE_DELETE = 'file_delete',
  TERMINAL_COMMAND = 'terminal_command',
  GIT_OPERATION = 'git_operation',
  PROJECT_ANALYSIS = 'project_analysis',

  // Control layer actions
  SEND_WHATSAPP = 'send_whatsapp',
  OPEN_BROWSER = 'open_browser',
  BROWSER_NAVIGATE = 'browser_navigate',
  OPEN_APP = 'open_app',
  CLOSE_APP = 'close_app',
  PC_CONTROL = 'pc_control',
  TAKE_SCREENSHOT = 'take_screenshot',

  // Communication department actions
  DRAFT_EMAIL = 'draft_email',
  SEND_EMAIL = 'send_email',
  READ_EMAIL = 'read_email',
  SUMMARIZE_THREAD = 'summarize_thread',
  TRANSLATE_MESSAGE = 'translate_message',

  // Informational actions
  WEB_SEARCH = 'web_search',
  SUMMARIZE = 'summarize',
  ANSWER_QUESTION = 'answer_question',
  TIME_DATE = 'time_date',
  WEATHER = 'weather',

  // System actions
  MEMORY_STORE = 'memory_store',
  MEMORY_RECALL = 'memory_recall',
  SET_PREFERENCE = 'set_preference',
  SYSTEM_STATUS = 'system_status',

  // Conversational
  GREETING = 'greeting',
  FAREWELL = 'farewell',
  CLARIFICATION = 'clarification',
  UNKNOWN = 'unknown',
}

/** Context object attached to intents for richer decision-making */
export interface IntentContext {
  /** Related past conversations */
  relatedMemories?: MemoryEntry[];
  /** User preferences relevant to this action */
  preferences?: Record<string, string>;
  /** Current system state */
  systemState?: SystemState;
}

/** A single memory entry stored in the persistent database */
export interface MemoryEntry {
  id: FridayId;
  type: 'conversation' | 'task' | 'preference' | 'contact' | 'fact';
  key: string;
  value: string;
  metadata: Record<string, string>;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
}

/** System state snapshot for context injection */
export interface SystemState {
  clawAvailable: boolean;
  activeTaskCount: number;
  memoryEntries: number;
  uptime: number;
  lastAction?: TaskResult;
}

/** The result of executing a task through any layer */
export interface TaskResult {
  id: FridayId;
  intentId: FridayId;
  success: boolean;
  output: string;
  error?: string;
  /** Which layer executed this task */
  executor: 'claw' | 'control' | 'memory' | 'internal' | 'communication';
  /** Time taken in milliseconds */
  durationMs: number;
  /** Risk level of the executed action */
  risk: RiskLevel;
  /** Whether user approval was obtained */
  approved: boolean;
  timestamp: string;
}

/** Approval request sent to the user for high-risk actions */
export interface ApprovalRequest {
  id: FridayId;
  intent: Intent;
  description: string;
  risk: RiskLevel;
  /** What will happen if approved */
  impact: string;
  /** Whether this is still pending */
  pending: boolean;
  createdAt: string;
}

/** WebSocket message types for real-time communication */
export enum WsMessageType {
  // Client → Server
  VOICE_DATA = 'voice_data',
  TEXT_INPUT = 'text_input',
  APPROVAL_RESPONSE = 'approval_response',
  CANCEL_TASK = 'cancel_task',

  // Server → Client
  TRANSCRIPT = 'transcript',
  INTENT_PARSED = 'intent_parsed',
  TASK_STARTED = 'task_started',
  TASK_PROGRESS = 'task_progress',
  TASK_COMPLETED = 'task_completed',
  TASK_FAILED = 'task_failed',
  APPROVAL_NEEDED = 'approval_needed',
  TTS_AUDIO = 'tts_audio',
  SYSTEM_STATUS = 'system_status',
  WATCHER_UPDATED = 'watcher:updated',
  NOTIFICATION_NEW = 'notification:new',
  REMINDER_TRIGGERED = 'reminder:triggered',
  TASK_EVENT = 'task:event',
  PRESENTATION_EVENT = 'presentation:event',
  VOICE_STATE = 'voice:state',
  VOICE_WAKE = 'voice:wake',
  VOICE_TRANSCRIPT = 'voice:transcript',
  ERROR = 'error',
}

/** WebSocket message envelope */
export interface WsMessage {
  type: WsMessageType;
  payload: unknown;
  timestamp: string;
}

/** Configuration object loaded from environment */
export interface FridayConfig {
  port: number;
  host: string;
  clawBinaryPath: string;
  ollamaBaseUrl: string;
  ollamaModel: string;

  // Safety
  rateLimitPerMinute: number;
  highRiskLimitPerHour: number;
  requireHighRiskApproval: boolean;

  // Voice
  sttEngine: 'none' | 'whisper' | 'vosk';
  ttsEngine: 'edge' | 'sapi' | 'none';
  wakeWord: string;
  voiceEnabled?: boolean;
  voiceAutostart?: boolean;
  voiceWakeWordEnabled?: boolean;
  voiceWakePhrases?: string[];
  voiceTimezone?: string;
  voiceDefaultLanguage?: string;
  voiceListenTimeoutSeconds?: number;
  voiceMaxRecordingSeconds?: number;
  voiceTtsEnabled?: boolean;
  voiceLocalOnly?: boolean;

  // Memory
  dbPath: string;

  // Control
  allowedDirectories: string[];
  enableBrowserControl: boolean;
  enablePcControl: boolean;
}
