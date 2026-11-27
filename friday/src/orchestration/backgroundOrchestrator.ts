// ============================================================
// FRIDAY — Persistent Background Orchestrator
// Asynchronous DAG task execution, SQLite persistence,
// resource-aware concurrency, cancellation, retries & recovery
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { redactSecrets } from '../memory/redaction';
import { eventBus, FridayEvents, TaskLifecycleEventPayload } from '../shared/events';
import { WsMessageType } from '../shared/types';
import { createLayerLogger } from '../shared/logger';
import { ExecutionPlan, ExecutionPlanStep } from './toolPlanner';
import { CapabilityRegistry, CapabilityResult, getCapabilityRegistry } from './toolRegistry';
import { getSafetyGate } from './safetyGate';

const log = createLayerLogger('BackgroundOrchestrator');

export type BackgroundTaskStatus =
  | 'RECEIVED'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_FOR_APPROVAL'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'INTERRUPTED';

export type TaskStepStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_FOR_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT'
  | 'INTERRUPTED'
  | 'SKIPPED';

export type TaskClass = 'lightweight' | 'ai_intensive' | 'llm_generation';

export interface ResourcePolicyConfig {
  maxConcurrentLightweight: number;
  maxConcurrentAiIntensive: number;
  maxConcurrentLlm: number;
  defaultTaskTimeoutMs: number;
}

export const DEFAULT_RESOURCE_POLICY: ResourcePolicyConfig = {
  maxConcurrentLightweight: 3,
  maxConcurrentAiIntensive: 1,
  maxConcurrentLlm: 1,
  defaultTaskTimeoutMs: 60_000,
};

const TERMINAL_TASK_STATES = new Set<BackgroundTaskStatus>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);

export const ALLOWED_TASK_TRANSITIONS: Record<BackgroundTaskStatus, Set<BackgroundTaskStatus>> = {
  RECEIVED: new Set(['QUEUED', 'WAITING_FOR_APPROVAL', 'CANCELLED', 'FAILED']),
  QUEUED: new Set(['RUNNING', 'WAITING_FOR_APPROVAL', 'CANCELLED', 'TIMED_OUT', 'INTERRUPTED']),
  WAITING_FOR_APPROVAL: new Set(['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'INTERRUPTED']),
  RUNNING: new Set(['VERIFYING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'INTERRUPTED']),
  VERIFYING: new Set(['COMPLETED', 'FAILED', 'CANCELLED']),
  INTERRUPTED: new Set(['QUEUED', 'FAILED', 'CANCELLED']),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  TIMED_OUT: new Set(),
};

export interface BackgroundTaskRecord {
  id: string;
  ownerId: string;
  conversationId: string | null;
  idempotencyKey: string | null;
  status: BackgroundTaskStatus;
  taskClass: TaskClass;
  priority: number;
  originalRequest: string;
  executionPlan: ExecutionPlan;
  progress: number;
  resultSummary: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  timeoutMs: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface TaskStepRecord {
  id: string;
  taskId: string;
  stepId: string;
  capabilityId: string;
  status: TaskStepStatus;
  arguments: Record<string, unknown>;
  dependencies: string[];
  executionOrder: number;
  idempotent: boolean;
  attempts: number;
  maxAttempts: number;
  result: CapabilityResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface TaskEventRecord {
  id: string;
  taskId: string;
  stepId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SubmitPlanOptions {
  ownerId?: string;
  taskClass?: TaskClass;
  priority?: number;
  idempotencyKey?: string;
  timeoutMs?: number;
  grantedPermissions?: readonly string[];
  approvedHighRisk?: boolean;
  idempotentStepIds?: readonly string[];
  maxStepAttempts?: number;
}

interface QueuedTaskJob {
  taskId: string;
  taskClass: TaskClass;
  priority: number;
  enqueuedAt: number;
  grantedPermissions?: readonly string[];
  approvedHighRisk?: boolean;
  approvedStepApprovals?: Map<string, string>;
}

export class TaskConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskConflictError';
  }
}

export class BackgroundOrchestrator {
  private policy: ResourcePolicyConfig;
  private registry: CapabilityRegistry;
  private activeByClass: Record<TaskClass, Set<string>> = {
    lightweight: new Set(),
    ai_intensive: new Set(),
    llm_generation: new Set(),
  };
  private queue: QueuedTaskJob[] = [];
  private cancelledTasks: Set<string> = new Set();
  private runtimeContexts: Map<
    string,
    {
      grantedPermissions?: readonly string[];
      approvedHighRisk?: boolean;
      approvedStepApprovals?: Map<string, string>;
    }
  > = new Map();

  constructor(
    registry: CapabilityRegistry = getCapabilityRegistry(),
    policy: Partial<ResourcePolicyConfig> = {}
  ) {
    this.registry = registry;
    this.policy = { ...DEFAULT_RESOURCE_POLICY, ...policy };
  }

  setResourcePolicy(patch: Partial<ResourcePolicyConfig>): void {
    this.policy = { ...this.policy, ...patch };
  }

  getResourceStatus(): {
    policy: ResourcePolicyConfig;
    active: Record<TaskClass, number>;
    queuedCount: number;
    memoryRssMb: number;
  } {
    return {
      policy: { ...this.policy },
      active: {
        lightweight: this.activeByClass.lightweight.size,
        ai_intensive: this.activeByClass.ai_intensive.size,
        llm_generation: this.activeByClass.llm_generation.size,
      },
      queuedCount: this.queue.length,
      memoryRssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    };
  }

  /**
   * Submit a validated ExecutionPlan for asynchronous background execution.
   * Returns immediately with taskId without blocking for completion.
   */
  async submitPlan(
    plan: ExecutionPlan,
    options: SubmitPlanOptions = {}
  ): Promise<{ taskId: string; status: BackgroundTaskStatus; deduplicated: boolean }> {
    if (!plan || !plan.valid || plan.steps.length === 0) {
      const reasons = plan?.validationErrors?.join('; ') || 'ExecutionPlan is invalid or has no steps.';
      throw new Error(`Cannot submit invalid ExecutionPlan: ${reasons}`);
    }

    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) {
      throw new Error('SQLite database unavailable; cannot persist background task.');
    }

    const ownerId = options.ownerId || 'local';

    // Duplicate task submission check via idempotencyKey
    if (options.idempotencyKey) {
      const existing = db
        .prepare(`SELECT id, status FROM background_tasks WHERE idempotency_key = ? LIMIT 1`)
        .get(options.idempotencyKey) as { id: string; status: BackgroundTaskStatus } | undefined;
      if (existing) {
        return { taskId: existing.id, status: existing.status, deduplicated: true };
      }
    }

    const taskId = uuidv4();
    const taskClass: TaskClass = options.taskClass || 'lightweight';
    const priority = options.priority ?? 5;
    const timeoutMs = Math.max(500, options.timeoutMs ?? this.policy.defaultTaskTimeoutMs);
    const idempotentSet = new Set(options.idempotentStepIds || []);
    const safeRequest = redactSecrets(plan.originalRequest);
    const safePlanJson = redactSecrets(JSON.stringify(plan));

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO background_tasks (
          id, owner_id, conversation_id, idempotency_key, status, task_class, priority,
          original_request, execution_plan_json, progress, timeout_ms
        ) VALUES (?, ?, ?, ?, 'RECEIVED', ?, ?, ?, ?, 0, ?)`
      ).run(
        taskId,
        ownerId,
        plan.conversationId || null,
        options.idempotencyKey || null,
        taskClass,
        priority,
        safeRequest,
        safePlanJson,
        timeoutMs
      );

      const insertStep = db.prepare(
        `INSERT INTO task_steps (
          id, task_id, step_id, capability_id, status, arguments_json,
          dependencies_json, execution_order, idempotent, attempts, max_attempts
        ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, 0, ?)`
      );

      for (const step of plan.steps) {
        const cap = this.registry.get(step.capabilityId);
        const isIdempotent =
          idempotentSet.has(step.stepId) || (cap ? cap.riskLevel === 'low' : false);
        const maxAttempts = isIdempotent ? Math.max(1, options.maxStepAttempts ?? 2) : 1;

        insertStep.run(
          `${taskId}:${step.stepId}`,
          taskId,
          step.stepId,
          step.capabilityId,
          redactSecrets(JSON.stringify(step.arguments || {})),
          JSON.stringify(step.dependencies || []),
          step.executionOrder,
          isIdempotent ? 1 : 0,
          maxAttempts
        );
      }
    });
    tx();

    await this.recordAndEmitEvent(taskId, undefined, 'task.created', {
      taskId,
      conversationId: plan.conversationId,
      status: 'RECEIVED',
      progress: 0,
      timestamp: new Date().toISOString(),
      summary: `Task accepted with ${plan.steps.length} step(s).`,
    });

    this.runtimeContexts.set(taskId, {
      grantedPermissions: options.grantedPermissions,
      approvedHighRisk: options.approvedHighRisk,
    });

    await this.transitionTask(taskId, 'QUEUED');
    await this.recordAndEmitEvent(taskId, undefined, 'task.queued', {
      taskId,
      conversationId: plan.conversationId,
      status: 'QUEUED',
      progress: 0,
      timestamp: new Date().toISOString(),
      summary: 'Task queued for background execution.',
    });

    this.enqueueJob({
      taskId,
      taskClass,
      priority,
      enqueuedAt: Date.now(),
      grantedPermissions: options.grantedPermissions,
      approvedHighRisk: options.approvedHighRisk,
    });

    return { taskId, status: 'QUEUED', deduplicated: false };
  }

  /**
   * Cancel a pending, queued, or running task.
   */
  async cancelTask(taskId: string, ownerId = 'local'): Promise<BackgroundTaskRecord> {
    const task = await this.getTask(taskId, ownerId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found.`);
    }
    if (TERMINAL_TASK_STATES.has(task.status)) {
      throw new TaskConflictError(`Cannot cancel task in terminal state "${task.status}".`);
    }

    this.cancelledTasks.add(taskId);
    this.queue = this.queue.filter((j) => j.taskId !== taskId);

    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (db) {
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE task_steps SET status = 'CANCELLED', completed_at = datetime('now')
           WHERE task_id = ? AND status IN ('PENDING', 'QUEUED', 'WAITING_FOR_APPROVAL')`
        ).run(taskId);
      });
      tx();
    }

    await this.transitionTask(taskId, 'CANCELLED', {
      errorCode: 'CANCELLED',
      errorMessage: 'Cancelled by user.',
    });

    await getSafetyGate().cancelTaskApprovals(taskId);

    await this.recordAndEmitEvent(taskId, undefined, 'task.cancelled', {
      taskId,
      conversationId: task.conversationId || undefined,
      status: 'CANCELLED',
      progress: task.progress,
      timestamp: new Date().toISOString(),
      summary: 'Task cancelled.',
    });

    return (await this.getTask(taskId, ownerId))!;
  }

  /**
   * Resume a task that is WAITING_FOR_APPROVAL after its bound approval was APPROVED.
   */
  async resumeAfterApproval(
    taskId: string,
    approvalId: string,
    actorId: string
  ): Promise<{ resumed: boolean; reason?: string }> {
    const task = await this.getTask(taskId, actorId);
    if (!task) {
      return { resumed: false, reason: 'Task not found or owned by another actor' };
    }
    if (task.status !== 'WAITING_FOR_APPROVAL') {
      return { resumed: false, reason: `Task is ${task.status}, not WAITING_FOR_APPROVAL` };
    }

    const approval = await getSafetyGate().getBoundApproval(approvalId);
    if (!approval || approval.taskId !== taskId || approval.actorId !== actorId) {
      return { resumed: false, reason: 'Approval does not belong to this task or actor' };
    }
    if (approval.status !== 'APPROVED') {
      return { resumed: false, reason: `Approval status is ${approval.status}, expected APPROVED` };
    }

    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return { resumed: false, reason: 'Database unavailable' };

    if (approval.stepId) {
      db.prepare(
        `UPDATE task_steps
         SET status = 'PENDING', error_code = NULL, error_message = NULL
         WHERE task_id = ? AND step_id = ? AND status = 'WAITING_FOR_APPROVAL'`
      ).run(taskId, approval.stepId);
    }

    await this.transitionTask(taskId, 'QUEUED');

    const prevCtx = this.runtimeContexts.get(taskId) || {};
    const approvedStepApprovals = new Map(prevCtx.approvedStepApprovals || []);
    if (approval.stepId) {
      approvedStepApprovals.set(approval.stepId, approvalId);
    }

    this.runtimeContexts.set(taskId, {
      ...prevCtx,
      approvedStepApprovals,
    });

    this.enqueueJob({
      taskId,
      taskClass: task.taskClass,
      priority: task.priority,
      enqueuedAt: Date.now(),
      grantedPermissions: prevCtx.grantedPermissions,
      approvedHighRisk: false, // Never grant blanket high-risk; consumed per bound step
      approvedStepApprovals,
    });

    return { resumed: true };
  }

  /**
   * Handle rejection, expiration, or cancellation of a waiting step's approval.
   */
  async handleApprovalOutcome(
    taskId: string,
    stepId: string,
    outcome: 'REJECTED' | 'EXPIRED' | 'CANCELLED',
    reason: string
  ): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task || TERMINAL_TASK_STATES.has(task.status)) return;

    const store = await getMemoryStore();
    const db = store.getDatabase();
    const stepStatus: TaskStepStatus = outcome === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    const nextTaskStatus: BackgroundTaskStatus = outcome === 'CANCELLED' ? 'CANCELLED' : 'FAILED';

    if (db) {
      db.prepare(
        `UPDATE task_steps
         SET status = ?, error_code = ?, error_message = ?, completed_at = datetime('now')
         WHERE task_id = ? AND step_id = ? AND status = 'WAITING_FOR_APPROVAL'`
      ).run(stepStatus, `APPROVAL_${outcome}`, redactSecrets(reason), taskId, stepId);

      db.prepare(
        `UPDATE task_steps SET status = 'SKIPPED' WHERE task_id = ? AND status IN ('PENDING', 'QUEUED')`
      ).run(taskId);
    }

    await this.transitionTask(taskId, nextTaskStatus, {
      errorCode: `APPROVAL_${outcome}`,
      errorMessage: redactSecrets(reason),
    });

    await this.recordAndEmitEvent(
      taskId,
      stepId,
      outcome === 'CANCELLED' ? 'task.cancelled' : 'task.failed',
      {
        taskId,
        conversationId: task.conversationId || undefined,
        stepId,
        status: nextTaskStatus,
        progress: task.progress,
        timestamp: new Date().toISOString(),
        summary: reason,
      }
    );
  }

  /**
   * Recover interrupted/unfinished tasks after an application restart.
   * Preserves completed steps; never auto-reruns non-idempotent RUNNING steps.
   */
  async recoverOnBoot(): Promise<{ resumed: number; interrupted: number }> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return { resumed: 0, interrupted: 0 };

    const unfinished = db
      .prepare(
        `SELECT * FROM background_tasks WHERE status IN ('RECEIVED', 'QUEUED', 'RUNNING', 'VERIFYING', 'WAITING_FOR_APPROVAL')`
      )
      .all() as Array<Record<string, unknown>>;

    let resumed = 0;
    let interrupted = 0;

    for (const row of unfinished) {
      const task = this.mapTaskRow(row);
      const steps = await this.getTaskSteps(task.id);
      const runningUnsafe = steps.filter((s) => s.status === 'RUNNING' && !s.idempotent);

      if (runningUnsafe.length > 0) {
        const tx = db.transaction(() => {
          for (const s of runningUnsafe) {
            db.prepare(
              `UPDATE task_steps SET status = 'INTERRUPTED', error_code = 'AMBIGUOUS_SIDE_EFFECT',
               error_message = 'Step was running during shutdown and is not idempotent.'
               WHERE id = ?`
            ).run(s.id);
          }
          db.prepare(
            `UPDATE background_tasks SET status = 'INTERRUPTED', error_code = 'AMBIGUOUS_SIDE_EFFECT',
             error_message = 'Task interrupted while executing a non-idempotent step.',
             updated_at = datetime('now') WHERE id = ?`
          ).run(task.id);
        });
        tx();

        await this.recordAndEmitEvent(task.id, undefined, 'task.interrupted', {
          taskId: task.id,
          conversationId: task.conversationId || undefined,
          status: 'INTERRUPTED',
          progress: task.progress,
          timestamp: new Date().toISOString(),
          summary: 'Task marked INTERRUPTED due to ambiguous in-flight side effect.',
        });
        interrupted++;
        continue;
      }

      // Safe to resume: reset any idempotent RUNNING steps to PENDING and re-queue
      db.prepare(
        `UPDATE task_steps SET status = 'PENDING' WHERE task_id = ? AND status = 'RUNNING' AND idempotent = 1`
      ).run(task.id);
      db.prepare(
        `UPDATE background_tasks SET status = 'QUEUED', updated_at = datetime('now') WHERE id = ?`
      ).run(task.id);

      this.enqueueJob({
        taskId: task.id,
        taskClass: task.taskClass,
        priority: task.priority,
        enqueuedAt: Date.now(),
      });
      resumed++;
    }

    if (resumed > 0 || interrupted > 0) {
      log.info(`Restart recovery: resumed ${resumed} task(s), marked ${interrupted} interrupted`);
    }
    return { resumed, interrupted };
  }

  /**
   * Explicitly transition a task state, enforcing ALLOWED_TASK_TRANSITIONS.
   */
  async transitionTask(
    taskId: string,
    nextStatus: BackgroundTaskStatus,
    extra: Partial<{
      progress: number;
      resultSummary: string;
      errorCode: string;
      errorMessage: string;
    }> = {}
  ): Promise<void> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return;

    const currentRow = db
      .prepare(`SELECT status FROM background_tasks WHERE id = ?`)
      .get(taskId) as { status: BackgroundTaskStatus } | undefined;

    if (!currentRow) throw new Error(`Task "${taskId}" not found.`);

    const allowed = ALLOWED_TASK_TRANSITIONS[currentRow.status];
    if (!allowed || !allowed.has(nextStatus)) {
      throw new TaskConflictError(`Invalid task state transition: ${currentRow.status} -> ${nextStatus}`);
    }

    const sets = [`status = ?`, `updated_at = datetime('now')`];
    const params: unknown[] = [nextStatus];

    if (nextStatus === 'RUNNING') {
      sets.push(`started_at = COALESCE(started_at, datetime('now'))`);
    }
    if (TERMINAL_TASK_STATES.has(nextStatus)) {
      sets.push(`completed_at = datetime('now')`);
    }
    if (extra.progress !== undefined) {
      sets.push(`progress = ?`);
      params.push(extra.progress);
    }
    if (extra.resultSummary !== undefined) {
      sets.push(`result_summary = ?`);
      params.push(redactSecrets(extra.resultSummary));
    }
    if (extra.errorCode !== undefined) {
      sets.push(`error_code = ?`);
      params.push(extra.errorCode);
    }
    if (extra.errorMessage !== undefined) {
      sets.push(`error_message = ?`);
      params.push(redactSecrets(extra.errorMessage));
    }

    params.push(taskId);
    db.prepare(`UPDATE background_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  private enqueueJob(job: QueuedTaskJob): void {
    this.queue.push(job);
    this.queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
    this.drainQueue();
  }

  private drainQueue(): void {
    const limitFor = (cls: TaskClass): number => {
      if (cls === 'llm_generation') return this.policy.maxConcurrentLlm;
      if (cls === 'ai_intensive') return this.policy.maxConcurrentAiIntensive;
      return this.policy.maxConcurrentLightweight;
    };

    for (let i = 0; i < this.queue.length; ) {
      const job = this.queue[i];
      if (this.activeByClass[job.taskClass].size < limitFor(job.taskClass)) {
        this.queue.splice(i, 1);
        this.activeByClass[job.taskClass].add(job.taskId);
        // Dispatch asynchronously on next microtask/tick without blocking caller
        setImmediate(() => {
          this.executeTaskJob(job).finally(() => {
            this.activeByClass[job.taskClass].delete(job.taskId);
            this.drainQueue();
          });
        });
      } else {
        i++;
      }
    }
  }

  private async executeTaskJob(job: QueuedTaskJob): Promise<void> {
    const task = await this.getTask(job.taskId);
    if (!task || this.cancelledTasks.has(job.taskId) || TERMINAL_TASK_STATES.has(task.status)) {
      return;
    }

    try {
      await this.transitionTask(task.id, 'RUNNING', { progress: 5 });
      await this.recordAndEmitEvent(task.id, undefined, 'task.started', {
        taskId: task.id,
        conversationId: task.conversationId || undefined,
        status: 'RUNNING',
        progress: 5,
        timestamp: new Date().toISOString(),
        summary: 'Task execution started.',
      });
    } catch {
      return;
    }

    let taskTimedOut = false;
    const taskTimer = setTimeout(() => {
      taskTimedOut = true;
    }, task.timeoutMs);
    taskTimer.unref?.();

    try {
      const plan = task.executionPlan;
      const totalSteps = plan.steps.length;
      const outputs: string[] = [];

      for (const group of plan.parallelGroups) {
        if (this.cancelledTasks.has(task.id)) {
          return;
        }
        if (taskTimedOut) {
          await this.handleTaskTimeout(task);
          return;
        }

        const groupSteps = group
          .map((sid) => plan.steps.find((s) => s.stepId === sid))
          .filter((s): s is ExecutionPlanStep => Boolean(s));

        const stepResults = await Promise.all(
          groupSteps.map((step) =>
            this.executeStep(task, step, {
              grantedPermissions: job.grantedPermissions,
              approvedHighRisk: job.approvedHighRisk,
              approvedStepApprovals: job.approvedStepApprovals,
              isTimedOut: () => taskTimedOut,
            })
          )
        );

        if (this.cancelledTasks.has(task.id)) return;
        if (taskTimedOut) {
          await this.handleTaskTimeout(task);
          return;
        }

        const waitingStep = stepResults.find((r) => r.waitingApproval);
        if (waitingStep) {
          // Task is paused in WAITING_FOR_APPROVAL; preserve completed and pending steps
          return;
        }

        const failedStep = stepResults.find((r) => !r.ok);
        if (failedStep) {
          await this.markRemainingSkipped(task.id);
          const cur = await this.getTask(task.id);
          if (cur && !TERMINAL_TASK_STATES.has(cur.status)) {
            await this.transitionTask(task.id, 'FAILED', {
              errorCode: failedStep.errorCode || 'STEP_FAILED',
              errorMessage: failedStep.errorMessage || 'Step execution failed.',
            });
            await this.recordAndEmitEvent(task.id, failedStep.stepId, 'task.failed', {
              taskId: task.id,
              conversationId: task.conversationId || undefined,
              stepId: failedStep.stepId,
              status: 'FAILED',
              progress: cur.progress,
              timestamp: new Date().toISOString(),
              summary: failedStep.errorMessage || 'Task failed.',
            });
          }
          return;
        }

        for (const r of stepResults) {
          if (r.message) outputs.push(r.message);
        }

        const allSteps = await this.getTaskSteps(task.id);
        const completedCount = allSteps.filter((s) => s.status === 'COMPLETED').length;
        const pct = Math.min(95, Math.round((completedCount / totalSteps) * 90) + 5);
        const cur = await this.getTask(task.id);
        if (cur && cur.status === 'RUNNING') {
          const store = await getMemoryStore();
          store.getDatabase()?.prepare(`UPDATE background_tasks SET progress = ?, updated_at = datetime('now') WHERE id = ?`).run(pct, task.id);
          await this.recordAndEmitEvent(task.id, undefined, 'task.progress', {
            taskId: task.id,
            conversationId: task.conversationId || undefined,
            status: 'RUNNING',
            progress: pct,
            timestamp: new Date().toISOString(),
            summary: `Completed ${completedCount} of ${totalSteps} step(s).`,
          });
        }
      }

      if (this.cancelledTasks.has(task.id)) return;
      if (taskTimedOut) {
        await this.handleTaskTimeout(task);
        return;
      }

      await this.transitionTask(task.id, 'VERIFYING', { progress: 98 });
      await this.transitionTask(task.id, 'COMPLETED', {
        progress: 100,
        resultSummary: outputs.join('\n') || 'Completed.',
      });

      await this.recordAndEmitEvent(task.id, undefined, 'task.completed', {
        taskId: task.id,
        conversationId: task.conversationId || undefined,
        status: 'COMPLETED',
        progress: 100,
        timestamp: new Date().toISOString(),
        summary: 'Task completed and verified.',
      });
    } finally {
      clearTimeout(taskTimer);
      this.runtimeContexts.delete(task.id);
    }
  }

  private async executeStep(
    task: BackgroundTaskRecord,
    step: ExecutionPlanStep,
    ctx: {
      grantedPermissions?: readonly string[];
      approvedHighRisk?: boolean;
      approvedStepApprovals?: Map<string, string>;
      isTimedOut: () => boolean;
    }
  ): Promise<{
    ok: boolean;
    stepId: string;
    waitingApproval?: boolean;
    approvalId?: string;
    message?: string;
    errorCode?: string;
    errorMessage?: string;
  }> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return { ok: false, stepId: step.stepId, errorCode: 'DB_UNAVAILABLE', errorMessage: 'DB unavailable' };

    const stepRow = (await this.getTaskSteps(task.id)).find((s) => s.stepId === step.stepId);
    if (!stepRow) return { ok: false, stepId: step.stepId, errorCode: 'STEP_MISSING', errorMessage: 'Step missing' };

    // Preserve already-completed steps during restart recovery or approval resumption
    if (stepRow.status === 'COMPLETED' && stepRow.result) {
      return { ok: true, stepId: step.stepId, message: stepRow.result.message };
    }

    // Ensure all dependencies completed
    const allSteps = await this.getTaskSteps(task.id);
    for (const depId of step.dependencies) {
      const dep = allSteps.find((s) => s.stepId === depId);
      if (!dep || dep.status !== 'COMPLETED') {
        db.prepare(`UPDATE task_steps SET status = 'SKIPPED' WHERE id = ?`).run(stepRow.id);
        return {
          ok: false,
          stepId: step.stepId,
          errorCode: 'DEPENDENCY_FAILED',
          errorMessage: `Dependency "${depId}" did not complete.`,
        };
      }
    }

    const actorId = task.ownerId || 'local';
    const deviceId = actorId.startsWith('device:') ? actorId.slice(7) : 'local';
    const capMeta = this.registry.get(step.capabilityId);
    const permissionScope = (capMeta?.permissions || []).slice().sort().join(',') || 'default';

    // If resuming via an explicit bound approval for this step, atomically verify & consume it first
    let stepApprovedHighRisk = Boolean(ctx.approvedHighRisk);
    let stepGrantedPermissions = ctx.grantedPermissions;
    const boundApprovalId = ctx.approvedStepApprovals?.get(step.stepId);
    if (boundApprovalId) {
      const consumed = await getSafetyGate().consumeBoundApproval({
        approvalId: boundApprovalId,
        taskId: task.id,
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        args: step.arguments,
        actorId,
        deviceId,
        permissionScope,
      });
      if (!consumed.ok) {
        db.prepare(
          `UPDATE task_steps SET status = 'FAILED', error_code = 'APPROVAL_CONSUMPTION_FAILED', error_message = ?, completed_at = datetime('now') WHERE id = ?`
        ).run(redactSecrets(consumed.error || 'Approval verification failed'), stepRow.id);
        return {
          ok: false,
          stepId: step.stepId,
          errorCode: 'APPROVAL_CONSUMPTION_FAILED',
          errorMessage: consumed.error || 'Approval verification failed',
        };
      }
      ctx.approvedStepApprovals?.delete(step.stepId);
      stepApprovedHighRisk = true;
      if (capMeta?.permissions?.length) {
        stepGrantedPermissions = Array.from(
          new Set([...(ctx.grantedPermissions || []), ...capMeta.permissions])
        );
      }
    }

    let lastRes: CapabilityResult | null = null;
    for (let attempt = 1; attempt <= stepRow.maxAttempts; attempt++) {
      if (this.cancelledTasks.has(task.id) || ctx.isTimedOut()) {
        return { ok: false, stepId: step.stepId, errorCode: 'ABORTED', errorMessage: 'Task aborted' };
      }

      db.prepare(
        `UPDATE task_steps SET status = 'RUNNING', attempts = ?, started_at = COALESCE(started_at, datetime('now')) WHERE id = ?`
      ).run(attempt, stepRow.id);

      await this.recordAndEmitEvent(task.id, step.stepId, 'task.step.started', {
        taskId: task.id,
        conversationId: task.conversationId || undefined,
        stepId: step.stepId,
        status: 'RUNNING',
        progress: task.progress,
        timestamp: new Date().toISOString(),
        summary: `Starting ${step.capabilityName} (attempt ${attempt}/${stepRow.maxAttempts}).`,
      });

      const res = await this.registry.execute(step.capabilityId, step.arguments, {
        actor: actorId,
        taskId: task.id,
        grantedPermissions: stepGrantedPermissions,
        approvedHighRisk: stepApprovedHighRisk,
      });
      lastRes = res;

      if (res.success && res.verified) {
        db.prepare(
          `UPDATE task_steps SET status = 'COMPLETED', result_json = ?, completed_at = datetime('now'), duration_ms = ? WHERE id = ?`
        ).run(redactSecrets(JSON.stringify(res)), res.durationMs, stepRow.id);

        await this.recordAndEmitEvent(task.id, step.stepId, 'task.step.completed', {
          taskId: task.id,
          conversationId: task.conversationId || undefined,
          stepId: step.stepId,
          status: 'COMPLETED',
          progress: task.progress,
          timestamp: new Date().toISOString(),
          summary: `${step.capabilityName} completed.`,
        });
        return { ok: true, stepId: step.stepId, message: res.message };
      }

      if (res.requiresApproval) {
        const boundApproval = await getSafetyGate().createBoundApproval({
          taskId: task.id,
          stepId: step.stepId,
          capabilityId: step.capabilityId,
          args: step.arguments,
          actorId,
          deviceId,
          permissionScope,
          riskLevel: step.riskLevel,
          summary: res.message || `Approval required for ${step.capabilityName}`,
        });

        db.prepare(
          `UPDATE task_steps SET status = 'WAITING_FOR_APPROVAL', error_code = 'APPROVAL_REQUIRED', error_message = ? WHERE id = ?`
        ).run(redactSecrets(res.message || 'Approval required'), stepRow.id);

        await this.transitionTask(task.id, 'WAITING_FOR_APPROVAL');
        await this.recordAndEmitEvent(task.id, step.stepId, 'task.waiting_approval', {
          taskId: task.id,
          conversationId: task.conversationId || undefined,
          stepId: step.stepId,
          status: 'WAITING_FOR_APPROVAL',
          progress: task.progress,
          timestamp: new Date().toISOString(),
          summary: `${res.message} (approvalId: ${boundApproval.approvalId})`,
        });
        return {
          ok: false,
          waitingApproval: true,
          approvalId: boundApproval.approvalId,
          stepId: step.stepId,
          errorCode: 'APPROVAL_REQUIRED',
          errorMessage: res.message,
        };
      }

      // Only retry if idempotent and attempts remain
      if (!stepRow.idempotent || attempt >= stepRow.maxAttempts) {
        break;
      }
    }

    const isTimeout = Boolean(lastRes?.error && /timed out/i.test(lastRes.error));
    const stepFinalStatus: TaskStepStatus = isTimeout ? 'TIMED_OUT' : 'FAILED';
    db.prepare(
      `UPDATE task_steps SET status = ?, error_code = ?, error_message = ?, completed_at = datetime('now'), duration_ms = ? WHERE id = ?`
    ).run(
      stepFinalStatus,
      isTimeout ? 'STEP_TIMEOUT' : 'STEP_FAILED',
      redactSecrets(lastRes?.error || lastRes?.message || 'Step failed'),
      lastRes?.durationMs ?? 0,
      stepRow.id
    );

    await this.recordAndEmitEvent(task.id, step.stepId, 'task.step.failed', {
      taskId: task.id,
      conversationId: task.conversationId || undefined,
      stepId: step.stepId,
      status: stepFinalStatus,
      progress: task.progress,
      timestamp: new Date().toISOString(),
      summary: lastRes?.error || lastRes?.message || `${step.capabilityName} failed.`,
    });

    return {
      ok: false,
      stepId: step.stepId,
      errorCode: isTimeout ? 'STEP_TIMEOUT' : 'STEP_FAILED',
      errorMessage: lastRes?.error || lastRes?.message || 'Step failed',
    };
  }

  private async handleTaskTimeout(task: BackgroundTaskRecord): Promise<void> {
    const cur = await this.getTask(task.id);
    if (!cur || TERMINAL_TASK_STATES.has(cur.status)) return;

    const store = await getMemoryStore();
    store
      .getDatabase()
      ?.prepare(
        `UPDATE task_steps SET status = 'TIMED_OUT', completed_at = datetime('now') WHERE task_id = ? AND status IN ('PENDING', 'QUEUED', 'RUNNING')`
      )
      .run(task.id);

    await this.transitionTask(task.id, 'TIMED_OUT', {
      errorCode: 'TASK_TIMEOUT',
      errorMessage: `Task exceeded timeout of ${task.timeoutMs}ms.`,
    });

    await this.recordAndEmitEvent(task.id, undefined, 'task.timed_out', {
      taskId: task.id,
      conversationId: task.conversationId || undefined,
      status: 'TIMED_OUT',
      progress: cur.progress,
      timestamp: new Date().toISOString(),
      summary: `Task timed out after ${task.timeoutMs}ms.`,
    });
  }

  private async markRemainingSkipped(taskId: string): Promise<void> {
    const store = await getMemoryStore();
    store
      .getDatabase()
      ?.prepare(
        `UPDATE task_steps SET status = 'SKIPPED' WHERE task_id = ? AND status IN ('PENDING', 'QUEUED')`
      )
      .run(taskId);
  }

  private async recordAndEmitEvent(
    taskId: string,
    stepId: string | undefined,
    eventType: keyof FridayEvents & string,
    payload: TaskLifecycleEventPayload
  ): Promise<void> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    let ownerId = 'local';
    if (db) {
      db.prepare(
        `INSERT INTO task_events (id, task_id, step_id, event_type, payload_json) VALUES (?, ?, ?, ?, ?)`
      ).run(uuidv4(), taskId, stepId || null, eventType, redactSecrets(JSON.stringify(payload)));
      const ownerRow = db.prepare(`SELECT owner_id FROM background_tasks WHERE id = ?`).get(taskId) as
        | { owner_id?: string }
        | undefined;
      if (ownerRow?.owner_id) {
        ownerId = String(ownerRow.owner_id);
      }
    }

    eventBus.emitEvent(eventType, payload);
    eventBus.emitEvent('ws:broadcast', {
      type: WsMessageType.TASK_EVENT,
      payload: { eventType, ownerId, ...payload },
      timestamp: payload.timestamp,
    });
  }

  async getTask(taskId: string, ownerId?: string): Promise<BackgroundTaskRecord | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const row = ownerId
      ? (db.prepare(`SELECT * FROM background_tasks WHERE id = ? AND owner_id = ?`).get(taskId, ownerId) as
          | Record<string, unknown>
          | undefined)
      : (db.prepare(`SELECT * FROM background_tasks WHERE id = ?`).get(taskId) as Record<string, unknown> | undefined);

    return row ? this.mapTaskRow(row) : null;
  }

  async listTasks(ownerId = 'local', limit = 50): Promise<BackgroundTaskRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    const rows = db
      .prepare(`SELECT * FROM background_tasks WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(ownerId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapTaskRow(r));
  }

  async getTaskSteps(taskId: string): Promise<TaskStepRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    const rows = db
      .prepare(`SELECT * FROM task_steps WHERE task_id = ? ORDER BY execution_order ASC`)
      .all(taskId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      stepId: String(r.step_id),
      capabilityId: String(r.capability_id),
      status: r.status as TaskStepStatus,
      arguments: JSON.parse(String(r.arguments_json || '{}')),
      dependencies: JSON.parse(String(r.dependencies_json || '[]')),
      executionOrder: Number(r.execution_order),
      idempotent: Number(r.idempotent) === 1,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      result: r.result_json ? JSON.parse(String(r.result_json)) : null,
      errorCode: r.error_code ? String(r.error_code) : null,
      errorMessage: r.error_message ? String(r.error_message) : null,
      startedAt: r.started_at ? String(r.started_at) : null,
      completedAt: r.completed_at ? String(r.completed_at) : null,
      durationMs: r.duration_ms !== null && r.duration_ms !== undefined ? Number(r.duration_ms) : null,
    }));
  }

  async getTaskEvents(taskId: string, limit = 100): Promise<TaskEventRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    const rows = db
      .prepare(`SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC LIMIT ?`)
      .all(taskId, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      stepId: r.step_id ? String(r.step_id) : null,
      eventType: String(r.event_type),
      payload: JSON.parse(String(r.payload_json || '{}')),
      createdAt: String(r.created_at),
    }));
  }

  private mapTaskRow(r: Record<string, unknown>): BackgroundTaskRecord {
    return {
      id: String(r.id),
      ownerId: String(r.owner_id),
      conversationId: r.conversation_id ? String(r.conversation_id) : null,
      idempotencyKey: r.idempotency_key ? String(r.idempotency_key) : null,
      status: r.status as BackgroundTaskStatus,
      taskClass: r.task_class as TaskClass,
      priority: Number(r.priority),
      originalRequest: String(r.original_request),
      executionPlan: JSON.parse(String(r.execution_plan_json)),
      progress: Number(r.progress),
      resultSummary: r.result_summary ? String(r.result_summary) : null,
      errorCode: r.error_code ? String(r.error_code) : null,
      errorMessage: r.error_message ? String(r.error_message) : null,
      timeoutMs: Number(r.timeout_ms),
      createdAt: String(r.created_at),
      startedAt: r.started_at ? String(r.started_at) : null,
      completedAt: r.completed_at ? String(r.completed_at) : null,
      updatedAt: String(r.updated_at),
    };
  }
}

let _orchestrator: BackgroundOrchestrator | null = null;
export function getBackgroundOrchestrator(): BackgroundOrchestrator {
  if (!_orchestrator) {
    _orchestrator = new BackgroundOrchestrator();
  }
  return _orchestrator;
}
