// ============================================================
// Communication Department — Executor
// Handles draft_email, send_email, read_email,
// summarize_thread, translate_message, and send_whatsapp.
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { createLayerLogger } from '../../shared/logger';
import { ActionType, RiskLevel, TaskResult, Intent } from '../../shared/types';
import { getClawBridge } from '../../orchestration/clawBridge';
import { getSafetyGate } from '../../orchestration/safetyGate';
import { getMemoryStore } from '../../memory/store';
import { CommunicationTask, EmailProviderInterface } from './types';

const log = createLayerLogger('CommunicationExecutor');

/**
 * Run a communication-department task and return a FRIDAY `TaskResult`.
 *
 * Routing:
 * - draft_email / summarize_thread / translate_message / read_email
 *     → LOW risk, no approval needed
 * - send_email
 *     → HIGH risk, routed through SafetyGate for approval
 * - send_whatsapp
 *     → Delegated to the existing Control layer via `executeControlAction`
 */
export async function runCommunicationTask(
  task: CommunicationTask,
  emailProvider: EmailProviderInterface
): Promise<TaskResult> {
  const startTime = Date.now();

  log.info(`Communication task: ${task.action}`, { action: task.action });

  try {
    switch (task.action) {
      case ActionType.DRAFT_EMAIL:
        return await handleDraftEmail(task, startTime);

      case ActionType.SEND_EMAIL:
        return await handleSendEmail(task, emailProvider, startTime);

      case ActionType.READ_EMAIL:
        return await handleReadEmail(task, emailProvider, startTime);

      case ActionType.SUMMARIZE_THREAD:
        return await handleSummarizeThread(task, emailProvider, startTime);

      case ActionType.TRANSLATE_MESSAGE:
        return await handleTranslateMessage(task, startTime);

      case ActionType.SEND_WHATSAPP:
        return await handleSendWhatsApp(task, startTime);

      default:
        return failResult(
          `Unknown communication action: ${task.action}`,
          startTime
        );
    }
  } catch (error) {
    log.error('Communication task failed', {
      action: task.action,
      error: (error as Error).message,
    });
    return failResult(
      `Communication error: ${(error as Error).message}`,
      startTime
    );
  }
}

// ── Handlers ────────────────────────────────────────────────

/**
 * draft_email — Uses Claw to compose an email body from the user's
 * natural-language request.  LOW risk, no approval.
 */
async function handleDraftEmail(
  task: CommunicationTask,
  startTime: number
): Promise<TaskResult> {
  const bridge = getClawBridge();

  const prompt = buildDraftPrompt(task);

  log.info('Drafting email via Claw', { promptLength: prompt.length });

  const clawResult = await bridge.invoke({ prompt });

  return {
    id: uuidv4(),
    intentId: uuidv4(),
    success: clawResult.success,
    output: clawResult.success
      ? `📧 **Draft Email**\n\n${clawResult.output}`
      : `Failed to draft email: ${clawResult.error}`,
    error: clawResult.error,
    executor: 'communication',
    durationMs: Date.now() - startTime,
    risk: RiskLevel.LOW,
    approved: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * send_email — HIGH risk. Evaluates via SafetyGate; if approved,
 * sends through the email provider and logs to memory.
 */
async function handleSendEmail(
  task: CommunicationTask,
  emailProvider: EmailProviderInterface,
  startTime: number
): Promise<TaskResult> {
  const to = task.to || '';
  const subject = task.subject || '(no subject)';
  let body = task.body || '';

  if (!to) {
    return failResult('Cannot send email — no recipient ("to") specified.', startTime);
  }

  // If no body provided, use Claw to draft one from rawInput
  if (!body) {
    const bridge = getClawBridge();
    const clawResult = await bridge.invoke({
      prompt: buildDraftPrompt(task),
    });
    if (clawResult.success) {
      body = clawResult.output;
    } else {
      return failResult(
        `Failed to generate email body: ${clawResult.error}`,
        startTime
      );
    }
  }

  // Safety gate evaluation — build a synthetic intent for the gate
  const safetyGate = getSafetyGate();
  const syntheticIntent: Intent = {
    id: uuidv4(),
    rawInput: task.rawInput,
    action: ActionType.SEND_EMAIL,
    params: { to, subject },
    confidence: 1,
    risk: RiskLevel.HIGH,
    timestamp: new Date().toISOString(),
  };

  const evaluation = await safetyGate.evaluate(syntheticIntent);

  if (!evaluation.allowed) {
    return {
      id: uuidv4(),
      intentId: syntheticIntent.id,
      success: false,
      output: `⏸️ Email send requires approval: ${evaluation.reason}`,
      executor: 'communication',
      durationMs: Date.now() - startTime,
      risk: RiskLevel.HIGH,
      approved: false,
      timestamp: new Date().toISOString(),
    };
  }

  // Send the email
  const messageId = await emailProvider.sendEmail({
    to: to.split(',').map((s) => s.trim()),
    cc: task.cc ? task.cc.split(',').map((s) => s.trim()) : undefined,
    bcc: task.bcc ? task.bcc.split(',').map((s) => s.trim()) : undefined,
    subject,
    body,
  });

  // Log to memory
  try {
    const memoryStore = await getMemoryStore();
    memoryStore.store('task', `email_sent:${to}`, `Sent email "${subject}" to ${to}`, {
      messageId,
      to,
      subject,
    });
  } catch (memErr) {
    log.warn('Failed to log email to memory', { error: (memErr as Error).message });
  }

  return {
    id: uuidv4(),
    intentId: syntheticIntent.id,
    success: true,
    output: `✅ Email sent to ${to} — subject: "${subject}" (Message-ID: ${messageId})`,
    executor: 'communication',
    durationMs: Date.now() - startTime,
    risk: RiskLevel.HIGH,
    approved: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * read_email — LOW risk. Fetches emails from the IMAP provider
 * and returns a formatted summary.
 */
async function handleReadEmail(
  task: CommunicationTask,
  emailProvider: EmailProviderInterface,
  startTime: number
): Promise<TaskResult> {
  const emails = await emailProvider.readEmails({
    folder: task.folder || 'INBOX',
    from: task.to, // re-use "to" param as "from" filter when reading
    unreadOnly: task.rawInput.toLowerCase().includes('unread'),
    limit: 10,
    query: task.query,
  });

  if (emails.length === 0) {
    return {
      id: uuidv4(),
      intentId: uuidv4(),
      success: true,
      output: '📭 No emails found matching your criteria.',
      executor: 'communication',
      durationMs: Date.now() - startTime,
      risk: RiskLevel.LOW,
      approved: true,
      timestamp: new Date().toISOString(),
    };
  }

  const formatted = emails
    .map(
      (e, i) =>
        `**${i + 1}.** From: ${e.from}\n   Subject: ${e.subject}\n   Date: ${e.date}`
    )
    .join('\n\n');

  return {
    id: uuidv4(),
    intentId: uuidv4(),
    success: true,
    output: `📬 **${emails.length} email(s) found:**\n\n${formatted}`,
    executor: 'communication',
    durationMs: Date.now() - startTime,
    risk: RiskLevel.LOW,
    approved: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * summarize_thread — LOW risk. Fetches the thread then passes
 * all messages to Claw for summarization.
 */
async function handleSummarizeThread(
  task: CommunicationTask,
  emailProvider: EmailProviderInterface,
  startTime: number
): Promise<TaskResult> {
  const threadId = task.threadId || task.query || '';
  if (!threadId) {
    return failResult('No thread ID or query provided for summarization.', startTime);
  }

  const thread = await emailProvider.getThread(threadId);
  if (!thread || thread.messages.length === 0) {
    return failResult(`Thread "${threadId}" not found or empty.`, startTime);
  }

  // Format thread for Claw
  const threadText = thread.messages
    .map((m) => `From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`)
    .join('\n---\n');

  const bridge = getClawBridge();
  const clawResult = await bridge.invoke({
    prompt: `Summarize this email thread concisely. Highlight key decisions, action items, and participants:\n\n${threadText}`,
  });

  return {
    id: uuidv4(),
    intentId: uuidv4(),
    success: clawResult.success,
    output: clawResult.success
      ? `📋 **Thread Summary** (${thread.messageCount} messages)\n\n${clawResult.output}`
      : `Failed to summarize thread: ${clawResult.error}`,
    error: clawResult.error,
    executor: 'communication',
    durationMs: Date.now() - startTime,
    risk: RiskLevel.LOW,
    approved: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * translate_message — LOW risk. Passes content to Claw with a
 * translation prompt.
 */
async function handleTranslateMessage(
  task: CommunicationTask,
  startTime: number
): Promise<TaskResult> {
  const language = task.language || 'English';
  const content = task.body || task.rawInput;

  const bridge = getClawBridge();
  const clawResult = await bridge.invoke({
    prompt: `Translate the following text into ${language}. Preserve formatting and tone:\n\n${content}`,
  });

  return {
    id: uuidv4(),
    intentId: uuidv4(),
    success: clawResult.success,
    output: clawResult.success
      ? `🌐 **Translation (→ ${language})**\n\n${clawResult.output}`
      : `Failed to translate: ${clawResult.error}`,
    error: clawResult.error,
    executor: 'communication',
    durationMs: Date.now() - startTime,
    risk: RiskLevel.LOW,
    approved: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * send_whatsapp — Delegates to the existing Control layer.
 * The control router already handles WhatsApp via URL scheme.
 */
async function handleSendWhatsApp(
  task: CommunicationTask,
  startTime: number
): Promise<TaskResult> {
  // Delegate to the control router by dynamically importing it
  const { executeControlAction } = await import('../../control/controlRouter');

  const syntheticIntent: Intent = {
    id: uuidv4(),
    rawInput: task.rawInput,
    action: ActionType.SEND_WHATSAPP,
    params: {
      contact: task.contact || '',
      message: task.message || '',
    },
    confidence: 1,
    risk: RiskLevel.HIGH,
    timestamp: new Date().toISOString(),
  };

  return executeControlAction(syntheticIntent);
}

// ── Helpers ─────────────────────────────────────────────────

function buildDraftPrompt(task: CommunicationTask): string {
  const parts = ['Draft a professional email'];
  if (task.to) parts.push(`to ${task.to}`);
  if (task.subject) parts.push(`with subject "${task.subject}"`);
  parts.push(`based on the following request:\n\n${task.rawInput}`);
  if (task.body) parts.push(`\n\nUse this as the basis for the body:\n${task.body}`);
  return parts.join(' ');
}

function failResult(error: string, startTime: number): TaskResult {
  return {
    id: uuidv4(),
    intentId: uuidv4(),
    success: false,
    output: '',
    error,
    executor: 'communication',
    durationMs: Date.now() - startTime,
    risk: RiskLevel.LOW,
    approved: true,
    timestamp: new Date().toISOString(),
  };
}
