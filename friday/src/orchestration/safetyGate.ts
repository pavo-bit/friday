// ============================================================
// FRIDAY — Safety Gate
// Risk classification + approval enforcement + rate limiting
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { createLayerLogger } from '../shared/logger';
import { getConfig } from '../shared/config';
import { eventBus } from '../shared/events';
import {
  getApprovalStore,
  BoundApprovalRecord,
  BoundApprovalStatus,
  CreateBoundApprovalInput,
  ResolveBoundApprovalResult,
  ConsumeBoundApprovalResult,
} from './approvalStore';
import {
  Intent,
  ActionType,
  RiskLevel,
  ApprovalRequest,
  WsMessageType,
} from '../shared/types';

const log = createLayerLogger('SafetyGate');

/** Risk classification rules — maps action types to risk levels */
const RISK_MAP: Record<ActionType, RiskLevel> = {
  // Low risk — read-only, informational
  [ActionType.FILE_READ]: RiskLevel.LOW,
  [ActionType.PROJECT_ANALYSIS]: RiskLevel.LOW,
  [ActionType.WEB_SEARCH]: RiskLevel.LOW,
  [ActionType.SUMMARIZE]: RiskLevel.LOW,
  [ActionType.ANSWER_QUESTION]: RiskLevel.LOW,
  [ActionType.TIME_DATE]: RiskLevel.LOW,
  [ActionType.WEATHER]: RiskLevel.LOW,
  [ActionType.MEMORY_RECALL]: RiskLevel.LOW,
  [ActionType.SYSTEM_STATUS]: RiskLevel.LOW,
  [ActionType.GREETING]: RiskLevel.LOW,
  [ActionType.FAREWELL]: RiskLevel.LOW,
  [ActionType.CLARIFICATION]: RiskLevel.LOW,
  [ActionType.UNKNOWN]: RiskLevel.LOW,

  // Medium risk — write operations, app control
  [ActionType.FILE_WRITE]: RiskLevel.MEDIUM,
  [ActionType.CODE_TASK]: RiskLevel.MEDIUM,
  [ActionType.GIT_OPERATION]: RiskLevel.MEDIUM,
  [ActionType.OPEN_BROWSER]: RiskLevel.MEDIUM,
  [ActionType.BROWSER_NAVIGATE]: RiskLevel.MEDIUM,
  [ActionType.OPEN_APP]: RiskLevel.MEDIUM,
  [ActionType.MEMORY_STORE]: RiskLevel.MEDIUM,
  [ActionType.SET_PREFERENCE]: RiskLevel.MEDIUM,
  [ActionType.TAKE_SCREENSHOT]: RiskLevel.MEDIUM,

  // High risk — destructive, external communication, sensitive
  [ActionType.FILE_DELETE]: RiskLevel.HIGH,
  [ActionType.TERMINAL_COMMAND]: RiskLevel.HIGH,
  [ActionType.SEND_WHATSAPP]: RiskLevel.HIGH,
  [ActionType.CLOSE_APP]: RiskLevel.HIGH,
  [ActionType.PC_CONTROL]: RiskLevel.HIGH,
  [ActionType.SEND_EMAIL]: RiskLevel.HIGH,

  // Communication — low risk (read-only / AI-assisted)
  [ActionType.DRAFT_EMAIL]: RiskLevel.LOW,
  [ActionType.READ_EMAIL]: RiskLevel.LOW,
  [ActionType.SUMMARIZE_THREAD]: RiskLevel.LOW,
  [ActionType.TRANSLATE_MESSAGE]: RiskLevel.LOW,
};

/**
 * SafetyGate — enforces risk policies before any action executes.
 *
 * Responsibilities:
 * 1. Classify every intent by risk level
 * 2. Enforce rate limits per time window
 * 3. Require user approval for high-risk actions
 * 4. Block dangerous patterns (prompt injection, path traversal)
 * 5. Maintain a full audit trail
 */
export class SafetyGate {
  private pendingApprovals: Map<string, ApprovalRequest> = new Map();
  private actionLog: Array<{ action: string; risk: RiskLevel; timestamp: number }> = [];
  private config = getConfig();

  /**
   * Classify the risk level of an intent.
   */
  classifyRisk(intent: Intent): RiskLevel {
    const baseRisk = RISK_MAP[intent.action] || RiskLevel.MEDIUM;

    // Escalate risk if suspicious patterns detected
    if (this.detectSuspiciousPatterns(intent)) {
      log.warn('Suspicious pattern detected — escalating to HIGH risk', {
        intentId: intent.id,
        action: intent.action,
      });
      return RiskLevel.HIGH;
    }

    return baseRisk;
  }

  /**
   * Check if an intent is allowed to execute.
   * Returns { allowed, reason, approvalRequest? }
   */
  async evaluate(intent: Intent): Promise<{
    allowed: boolean;
    reason: string;
    approvalRequest?: ApprovalRequest;
  }> {
    const risk = this.classifyRisk(intent);
    intent.risk = risk; // Update intent with classified risk

    // Check rate limits
    const rateLimitResult = this.checkRateLimit(risk);
    if (!rateLimitResult.allowed) {
      log.warn('Rate limit exceeded', { intentId: intent.id, reason: rateLimitResult.reason });
      eventBus.emitEvent('safety:rate_limited', intent.action);
      return rateLimitResult;
    }

    // Check blocked patterns
    const patternCheck = this.checkBlockedPatterns(intent);
    if (!patternCheck.allowed) {
      log.error('Blocked pattern detected', { intentId: intent.id, reason: patternCheck.reason });
      return patternCheck;
    }

    // Low and medium risk — auto-approve
    if (risk === RiskLevel.LOW || risk === RiskLevel.MEDIUM) {
      this.recordAction(intent.action, risk);
      return { allowed: true, reason: `Auto-approved (${risk} risk)` };
    }

    // High risk — require user approval if configured
    if (this.config.requireHighRiskApproval) {
      const approvalRequest = this.createApprovalRequest(intent, risk);
      return {
        allowed: false,
        reason: 'High-risk action requires user approval',
        approvalRequest,
      };
    }

    // High risk approval not required — auto-approve with warning
    log.warn('High-risk action auto-approved (approval requirement disabled)', {
      intentId: intent.id,
      action: intent.action,
    });
    this.recordAction(intent.action, risk);
    return { allowed: true, reason: 'Auto-approved (high-risk approval disabled)' };
  }

  /**
   * Process a user's approval or denial of a pending request.
   */
  processApproval(requestId: string, approved: boolean): boolean {
    const request = this.pendingApprovals.get(requestId);
    if (!request || !request.pending) {
      log.warn('Approval request not found or already processed', { requestId });
      return false;
    }

    request.pending = false;
    this.pendingApprovals.delete(requestId);

    if (approved) {
      log.info('High-risk action approved by user', {
        requestId,
        action: request.intent.action,
      });
      this.recordAction(request.intent.action, request.risk);
      eventBus.emitEvent('safety:approved', requestId);
    } else {
      log.info('High-risk action denied by user', {
        requestId,
        action: request.intent.action,
      });
      eventBus.emitEvent('safety:denied', requestId);
    }

    return true;
  }

  /** Get all pending approval requests */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values()).filter((r) => r.pending);
  }

  /** Check rate limits for the current time window */
  private checkRateLimit(risk: RiskLevel): { allowed: boolean; reason: string } {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    const oneHourAgo = now - 3_600_000;

    // Clean old entries
    this.actionLog = this.actionLog.filter((entry) => entry.timestamp > oneHourAgo);

    // Check per-minute rate limit
    const recentActions = this.actionLog.filter((entry) => entry.timestamp > oneMinuteAgo);
    if (recentActions.length >= this.config.rateLimitPerMinute) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${recentActions.length}/${this.config.rateLimitPerMinute} actions per minute`,
      };
    }

    // Check high-risk per-hour limit
    if (risk === RiskLevel.HIGH) {
      const highRiskRecent = this.actionLog.filter(
        (entry) => entry.risk === RiskLevel.HIGH && entry.timestamp > oneHourAgo
      );
      if (highRiskRecent.length >= this.config.highRiskLimitPerHour) {
        return {
          allowed: false,
          reason: `High-risk rate limit exceeded: ${highRiskRecent.length}/${this.config.highRiskLimitPerHour} per hour`,
        };
      }
    }

    return { allowed: true, reason: 'Within rate limits' };
  }

  /** Detect prompt injection and suspicious patterns */
  private detectSuspiciousPatterns(intent: Intent): boolean {
    const text = intent.rawInput.toLowerCase();
    const suspiciousPatterns = [
      'ignore previous instructions',
      'ignore all instructions',
      'you are now',
      'new system prompt',
      'override safety',
      'bypass security',
      'act as root',
      'sudo ',
      'rm -rf',
      'format c:',
      'del /f /s /q',
      ':(){ :|:& };:',  // Fork bomb
    ];

    return suspiciousPatterns.some((pattern) => text.includes(pattern));
  }

  /** Check for blocked command patterns */
  private checkBlockedPatterns(intent: Intent): { allowed: boolean; reason: string } {
    const text = intent.rawInput.toLowerCase();

    // Block path traversal attempts
    if (text.includes('..\\') || text.includes('../')) {
      if (intent.action === ActionType.FILE_DELETE || intent.action === ActionType.TERMINAL_COMMAND) {
        return {
          allowed: false,
          reason: 'Path traversal detected in destructive action — blocked for safety',
        };
      }
    }

    // Block attempts to access system directories
    const systemPaths = ['c:\\windows', '/etc/', '/usr/bin', 'system32'];
    if (systemPaths.some((p) => text.includes(p))) {
      if (intent.action === ActionType.FILE_DELETE || intent.action === ActionType.FILE_WRITE) {
        return {
          allowed: false,
          reason: 'Attempt to modify system files — blocked for safety',
        };
      }
    }

    return { allowed: true, reason: 'No blocked patterns found' };
  }

  /** Create an approval request for a high-risk action */
  private createApprovalRequest(intent: Intent, risk: RiskLevel): ApprovalRequest {
    const request: ApprovalRequest = {
      id: uuidv4(),
      intent,
      description: this.describeAction(intent),
      risk,
      impact: this.describeImpact(intent),
      pending: true,
      createdAt: new Date().toISOString(),
    };

    this.pendingApprovals.set(request.id, request);

    // Notify via event bus
    eventBus.emitEvent('safety:approval_needed', request);

    // Also broadcast via WebSocket for UI
    eventBus.emitEvent('ws:broadcast', {
      type: WsMessageType.APPROVAL_NEEDED,
      payload: request,
      timestamp: new Date().toISOString(),
    });

    log.info('Approval request created', {
      requestId: request.id,
      action: intent.action,
      risk,
    });

    return request;
  }

  /** Generate a human-readable description of an action */
  private describeAction(intent: Intent): string {
    switch (intent.action) {
      case ActionType.SEND_WHATSAPP:
        return `Send WhatsApp message to "${intent.params.contact}": "${intent.params.message}"`;
      case ActionType.FILE_DELETE:
        return `Delete file: ${intent.params.path || intent.params.target}`;
      case ActionType.TERMINAL_COMMAND:
        return `Execute terminal command: ${intent.params.command}`;
      case ActionType.PC_CONTROL:
        return `PC automation: ${intent.params.action || intent.rawInput}`;
      case ActionType.CLOSE_APP:
        return `Close application: ${intent.params.app}`;
      case ActionType.SEND_EMAIL:
        return `Send email to "${intent.params.to}": subject "${intent.params.subject || '(no subject)'}"`;
      default:
        return intent.rawInput;
    }
  }

  /** Describe the potential impact of an action */
  private describeImpact(intent: Intent): string {
    switch (intent.action) {
      case ActionType.SEND_WHATSAPP:
        return 'A message will be sent via WhatsApp Web. This cannot be undone.';
      case ActionType.FILE_DELETE:
        return 'The specified file will be permanently deleted from disk.';
      case ActionType.TERMINAL_COMMAND:
        return 'A command will be executed in the system terminal. This may modify system state.';
      case ActionType.PC_CONTROL:
        return 'Keyboard/mouse automation will be performed on your PC.';
      case ActionType.CLOSE_APP:
        return 'An application will be force-closed. Unsaved data may be lost.';
      case ActionType.SEND_EMAIL:
        return 'An email will be sent from your account. This cannot be undone.';
      default:
        return 'This action may have side effects that cannot be easily reversed.';
    }
  }

  /** Record an action for rate limiting */
  private recordAction(action: string, risk: RiskLevel): void {
    this.actionLog.push({
      action,
      risk,
      timestamp: Date.now(),
    });
  }

  // ---- Phase 4: Persistent Action-Bound Approvals ----

  createBoundApproval(input: CreateBoundApprovalInput): Promise<BoundApprovalRecord> {
    return getApprovalStore().create(input);
  }

  getBoundApproval(approvalId: string): Promise<BoundApprovalRecord | null> {
    return getApprovalStore().getById(approvalId);
  }

  listBoundApprovals(filter?: {
    actorId?: string;
    taskId?: string;
    status?: BoundApprovalStatus;
    limit?: number;
  }): Promise<BoundApprovalRecord[]> {
    return getApprovalStore().list(filter);
  }

  resolveBoundApproval(params: {
    approvalId: string;
    decision: 'APPROVE' | 'REJECT' | 'CANCEL';
    actorId: string;
    resolution?: string;
  }): Promise<ResolveBoundApprovalResult> {
    return getApprovalStore().resolve(params);
  }

  consumeBoundApproval(params: {
    approvalId: string;
    taskId: string;
    stepId: string;
    capabilityId: string;
    args: Record<string, unknown>;
    actorId: string;
    deviceId: string;
    permissionScope: string;
  }): Promise<ConsumeBoundApprovalResult> {
    return getApprovalStore().consume(params);
  }

  cancelTaskApprovals(taskId: string): Promise<number> {
    return getApprovalStore().cancelForTask(taskId);
  }
}

/** Singleton instance */
let _safetyGate: SafetyGate | null = null;

export function getSafetyGate(): SafetyGate {
  if (!_safetyGate) {
    _safetyGate = new SafetyGate();
  }
  return _safetyGate;
}
