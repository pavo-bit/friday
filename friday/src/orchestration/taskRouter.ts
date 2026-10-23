// ============================================================
// FRIDAY — Task Router
// Routes parsed intents to the correct executor layer
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { createLayerLogger } from '../shared/logger';
import { eventBus } from '../shared/events';
import {
  Intent,
  ActionType,
  TaskResult,
  RiskLevel,
  WsMessageType,
} from '../shared/types';
import { getClawBridge } from './clawBridge';
import { getSafetyGate } from './safetyGate';
import { RESPONSES } from '../intelligence/systemPrompt';
import { runCommunicationTask } from '../departments/communication/communicationExecutor';
import { SmtpImapProvider } from '../departments/communication/emailProvider';
import { CommunicationTask, EmailProviderInterface } from '../departments/communication/types';

const log = createLayerLogger('TaskRouter');

/** Actions that should be delegated to the Claw engine */
const CLAW_ACTIONS = new Set<ActionType>([
  ActionType.CODE_TASK,
  ActionType.FILE_READ,
  ActionType.FILE_WRITE,
  ActionType.FILE_DELETE,
  ActionType.TERMINAL_COMMAND,
  ActionType.GIT_OPERATION,
  ActionType.PROJECT_ANALYSIS,
  ActionType.WEB_SEARCH,
  ActionType.SUMMARIZE,
  ActionType.ANSWER_QUESTION,
]);

/** Actions handled by the Control Layer */
const CONTROL_ACTIONS = new Set<ActionType>([
  ActionType.OPEN_BROWSER,
  ActionType.BROWSER_NAVIGATE,
  ActionType.OPEN_APP,
  ActionType.CLOSE_APP,
  ActionType.PC_CONTROL,
  ActionType.TAKE_SCREENSHOT,
]);

/** Actions handled by the Communication Department */
const COMMUNICATION_ACTIONS = new Set<ActionType>([
  ActionType.DRAFT_EMAIL,
  ActionType.SEND_EMAIL,
  ActionType.READ_EMAIL,
  ActionType.SUMMARIZE_THREAD,
  ActionType.TRANSLATE_MESSAGE,
  ActionType.SEND_WHATSAPP,
]);

/** Actions handled internally by FRIDAY */
const INTERNAL_ACTIONS = new Set<ActionType>([
  ActionType.TIME_DATE,
  ActionType.WEATHER,
  ActionType.MEMORY_STORE,
  ActionType.MEMORY_RECALL,
  ActionType.SET_PREFERENCE,
  ActionType.SYSTEM_STATUS,
  ActionType.GREETING,
  ActionType.FAREWELL,
  ActionType.CLARIFICATION,
  ActionType.UNKNOWN,
]);

/**
 * TaskRouter — the central nervous system of FRIDAY.
 *
 * Receives parsed intents, evaluates safety, and dispatches
 * to the correct executor (Claw, Control, or Internal).
 */
export class TaskRouter {
  private taskHistory: TaskResult[] = [];

  /**
   * Route an intent to its executor.
   * This is the main entry point for all task execution.
   */
  async route(intent: Intent): Promise<TaskResult> {
    const startTime = Date.now();

    log.info(`Routing intent: ${intent.action}`, {
      intentId: intent.id,
      action: intent.action,
      confidence: intent.confidence,
    });

    // Emit task started event
    eventBus.emitEvent('task:started', intent);
    eventBus.emitEvent('ws:broadcast', {
      type: WsMessageType.TASK_STARTED,
      payload: { intentId: intent.id, action: intent.action },
      timestamp: new Date().toISOString(),
    });

    // Step 1: Safety evaluation
    const safetyGate = getSafetyGate();
    const safetyResult = await safetyGate.evaluate(intent);

    if (!safetyResult.allowed) {
      if (safetyResult.approvalRequest) {
        // High-risk action — wait for approval
        log.info('Action requires user approval', {
          intentId: intent.id,
          requestId: safetyResult.approvalRequest.id,
        });

        return this.createPendingResult(intent, safetyResult.reason, startTime);
      }

      // Blocked by safety policy
      return this.createFailedResult(
        intent,
        `Blocked by safety policy: ${safetyResult.reason}`,
        startTime
      );
    }

    // Step 2: Dispatch to correct executor
    try {
      let result: TaskResult;

      if (CLAW_ACTIONS.has(intent.action)) {
        result = await this.executeClaw(intent);
      } else if (COMMUNICATION_ACTIONS.has(intent.action)) {
        result = await this.executeCommunication(intent);
      } else if (CONTROL_ACTIONS.has(intent.action)) {
        result = await this.executeControl(intent);
      } else if (INTERNAL_ACTIONS.has(intent.action)) {
        result = await this.executeInternal(intent);
      } else {
        // Unknown action type — delegate to Claw as fallback
        log.warn(`Unknown action type: ${intent.action}, falling back to Claw`);
        result = await this.executeClaw(intent);
      }

      // Record result
      this.taskHistory.push(result);

      // Emit completion event
      const eventType = result.success ? 'task:completed' : 'task:failed';
      eventBus.emitEvent(eventType, result);
      eventBus.emitEvent('ws:broadcast', {
        type: result.success ? WsMessageType.TASK_COMPLETED : WsMessageType.TASK_FAILED,
        payload: result,
        timestamp: new Date().toISOString(),
      });

      return result;
    } catch (error) {
      const result = this.createFailedResult(
        intent,
        `Execution error: ${(error as Error).message}`,
        startTime
      );
      eventBus.emitEvent('task:failed', result);
      return result;
    }
  }

  /**
   * Execute a task via the Claw engine.
   */
  private async executeClaw(intent: Intent): Promise<TaskResult> {
    const bridge = getClawBridge();

    if (!bridge.isAvailable()) {
      return {
        id: uuidv4(),
        intentId: intent.id,
        success: false,
        output: '',
        error: 'Claw binary is not available. Build with: cd rust && cargo build --workspace',
        executor: 'claw',
        durationMs: 0,
        risk: intent.risk,
        approved: true,
        timestamp: new Date().toISOString(),
      };
    }

    // Build the prompt for Claw based on action type
    const clawPrompt = this.buildClawPrompt(intent);

    log.info(`Delegating to Claw: "${clawPrompt.substring(0, 100)}..."`, {
      intentId: intent.id,
    });

    const clawResult = await bridge.invoke({
      prompt: clawPrompt,
      intentId: intent.id,
      risk: intent.risk,
    });

    return bridge.toTaskResult(clawResult, intent.id, intent.risk);
  }

  /**
   * Execute a task via the Control Layer.
   */
  private async executeControl(intent: Intent): Promise<TaskResult> {
    const startTime = Date.now();

    // Control layer is implemented as a separate module
    // For now, return a structured stub that the control layer will fulfill
    log.info(`Control action: ${intent.action}`, {
      intentId: intent.id,
      params: intent.params,
    });

    try {
      // Dynamic import to avoid circular dependencies
      const { executeControlAction } = await import('../control/controlRouter');
      return await executeControlAction(intent);
    } catch (error) {
      return {
        id: uuidv4(),
        intentId: intent.id,
        success: false,
        output: '',
        error: `Control layer error: ${(error as Error).message}`,
        executor: 'control',
        durationMs: Date.now() - startTime,
        risk: intent.risk,
        approved: true,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Execute a task via the Communication Department.
   */
  private async executeCommunication(intent: Intent): Promise<TaskResult> {
    const startTime = Date.now();

    log.info(`Communication action: ${intent.action}`, {
      intentId: intent.id,
      params: intent.params,
    });

    try {
      const emailProvider = this.getEmailProvider();

      const task: CommunicationTask = {
        action: intent.action as CommunicationTask['action'],
        rawInput: intent.rawInput,
        to: intent.params.to,
        cc: intent.params.cc,
        bcc: intent.params.bcc,
        subject: intent.params.subject,
        body: intent.params.body,
        contact: intent.params.contact,
        message: intent.params.message,
        query: intent.params.query,
        language: intent.params.language,
        folder: intent.params.folder,
        threadId: intent.params.threadId,
      };

      return await runCommunicationTask(task, emailProvider);
    } catch (error) {
      return {
        id: uuidv4(),
        intentId: intent.id,
        success: false,
        output: '',
        error: `Communication layer error: ${(error as Error).message}`,
        executor: 'communication',
        durationMs: Date.now() - startTime,
        risk: intent.risk,
        approved: true,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Create an email provider from environment variables.
   * Lazily instantiated — only created when a communication action fires.
   */
  private _emailProvider: EmailProviderInterface | null = null;

  private getEmailProvider(): EmailProviderInterface {
    if (!this._emailProvider) {
      this._emailProvider = new SmtpImapProvider({
        smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
        smtpPort: Number(process.env.SMTP_PORT ?? 587),
        imapHost: process.env.IMAP_HOST || 'imap.gmail.com',
        imapPort: Number(process.env.IMAP_PORT ?? 993),
        user: process.env.EMAIL_USER || '',
        pass: process.env.EMAIL_PASS || '',
        fromAddress: process.env.EMAIL_FROM || '',
      });
    }
    return this._emailProvider;
  }

  /**
   * Execute a task handled internally by FRIDAY.
   */
  private async executeInternal(intent: Intent): Promise<TaskResult> {
    const startTime = Date.now();

    let output = '';

    switch (intent.action) {
      case ActionType.GREETING: {
        const hour = new Date().getHours();
        const timeOfDay = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
        output = RESPONSES.greeting(timeOfDay);
        break;
      }

      case ActionType.FAREWELL:
        output = RESPONSES.farewell();
        break;

      case ActionType.TIME_DATE: {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-IN', { hour12: true });
        const dateStr = now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        output = RESPONSES.timeResponse(timeStr, dateStr);
        break;
      }

      case ActionType.SYSTEM_STATUS: {
        const bridge = getClawBridge();
        const safetyGate = getSafetyGate();
        output = RESPONSES.systemStatus({
          'Claw Engine': bridge.isAvailable() ? 'Online' : 'Offline',
          'Active Tasks': bridge.getActiveCount().toString(),
          'Total Invocations': bridge.getTotalInvocations().toString(),
          'Pending Approvals': safetyGate.getPendingApprovals().length.toString(),
          'Uptime': `${Math.floor(process.uptime())}s`
        });
        break;
      }

      case ActionType.CLARIFICATION:
        output = RESPONSES.needClarification("Could you rephrase that? I can help with coding, searches, or system commands.");
        break;

      case ActionType.UNKNOWN:
        output = RESPONSES.unknownCommand();
        break;

      default:
        output = RESPONSES.taskFailed(`Internal action "${intent.action}" is not yet implemented.`);
    }

    return {
      id: uuidv4(),
      intentId: intent.id,
      success: true,
      output,
      executor: 'internal',
      durationMs: Date.now() - startTime,
      risk: RiskLevel.LOW,
      approved: true,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Build the prompt sent to Claw based on the structured intent.
   */
  private buildClawPrompt(intent: Intent): string {
    switch (intent.action) {
      case ActionType.FILE_READ:
        return `Read the file at ${intent.params.path || intent.params.target || intent.rawInput} and show me its contents.`;

      case ActionType.FILE_WRITE:
        return intent.rawInput;

      case ActionType.FILE_DELETE:
        return `Delete the file: ${intent.params.path || intent.params.target}`;

      case ActionType.CODE_TASK:
        return intent.rawInput;

      case ActionType.GIT_OPERATION:
        return intent.rawInput;

      case ActionType.PROJECT_ANALYSIS:
        return intent.rawInput;

      case ActionType.TERMINAL_COMMAND:
        return `Run this command: ${intent.params.command || intent.rawInput}`;

      case ActionType.WEB_SEARCH:
        return `Search the web for: ${intent.params.query || intent.rawInput}`;

      case ActionType.SUMMARIZE:
        return `Summarize: ${intent.params.target || intent.rawInput}`;

      case ActionType.ANSWER_QUESTION:
        return intent.rawInput;

      default:
        return intent.rawInput;
    }
  }


  /** Create a result for actions pending approval */
  private createPendingResult(intent: Intent, reason: string, startTime: number): TaskResult {
    return {
      id: uuidv4(),
      intentId: intent.id,
      success: false,
      output: `⏸️ Action requires your approval: ${reason}`,
      executor: 'internal',
      durationMs: Date.now() - startTime,
      risk: intent.risk,
      approved: false,
      timestamp: new Date().toISOString(),
    };
  }

  /** Create a failed result */
  private createFailedResult(intent: Intent, reason: string, startTime: number): TaskResult {
    return {
      id: uuidv4(),
      intentId: intent.id,
      success: false,
      output: '',
      error: reason,
      executor: 'internal',
      durationMs: Date.now() - startTime,
      risk: intent.risk,
      approved: false,
      timestamp: new Date().toISOString(),
    };
  }

  /** Get task history */
  getHistory(): TaskResult[] {
    return [...this.taskHistory];
  }

  /** Get recent tasks */
  getRecentTasks(limit = 20): TaskResult[] {
    return this.taskHistory.slice(-limit);
  }
}

/** Singleton instance */
let _router: TaskRouter | null = null;

export function getTaskRouter(): TaskRouter {
  if (!_router) {
    _router = new TaskRouter();
  }
  return _router;
}
