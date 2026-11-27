// ============================================================
// FRIDAY — API Routes: /friday/tasks/*
// Asynchronous background task submission, status, steps,
// events, cancellation, and result retrieval
// ============================================================

import { Router, Request, Response } from 'express';
import {
  getBackgroundOrchestrator,
  TaskClass,
  TaskConflictError,
} from '../../orchestration/backgroundOrchestrator';
import { getCapabilityDiscoveryEngine } from '../../orchestration/capabilityDiscovery';
import { getToolPlanner, ProposedPlanStepInput } from '../../orchestration/toolPlanner';
import { getAuthService } from '../../services/authService';
import { getConfig } from '../../shared/config';

export const taskRoutes = Router();

/**
 * Resolve caller owner ID from paired device token or localhost context.
 */
async function resolveOwnerId(req: Request): Promise<string> {
  const authHeader = req.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) {
    const device = await getAuthService().verifyToken(authHeader.slice(7).trim());
    if (device) return `device:${device.id}`;
  }

  const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1', getConfig().host]);
  const isLocal =
    req.ip === '127.0.0.1' ||
    req.ip === '::1' ||
    req.ip === '::ffff:127.0.0.1' ||
    allowedHosts.has(req.hostname);

  if (isLocal) {
    const headerOwner = req.get('x-friday-owner');
    return headerOwner && headerOwner.trim() ? headerOwner.trim() : 'local';
  }

  return 'unauthorized';
}

taskRoutes.post('/', async (req: Request, res: Response) => {
  const ownerId = await resolveOwnerId(req);
  if (ownerId === 'unauthorized') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = (req.body || {}) as {
    text?: string;
    plan?: { originalRequest?: string; steps?: ProposedPlanStepInput[] };
    conversationId?: string;
    idempotencyKey?: string;
    timeoutMs?: number;
    taskClass?: TaskClass;
    priority?: number;
    approvedHighRisk?: boolean;
  };

  if (!body.text && !body.plan) {
    res.status(400).json({ error: 'Provide either "text" or a structured "plan".' });
    return;
  }

  try {
    const planner = getToolPlanner();
    let validatedPlan;

    if (body.plan) {
      if (!Array.isArray(body.plan.steps) || body.plan.steps.length === 0) {
        res.status(400).json({ error: 'plan.steps must be a non-empty array.' });
        return;
      }
      validatedPlan = await planner.validateProposedPlan(
        {
          originalRequest: body.plan.originalRequest || 'Structured plan submission',
          steps: body.plan.steps,
        },
        { conversationId: body.conversationId }
      );
    } else {
      const discovery = await getCapabilityDiscoveryEngine().discover({
        request: String(body.text),
        conversationId: body.conversationId,
      });
      if (discovery.clarificationNeeded) {
        res.status(422).json({
          error: 'Clarification required before creating background task.',
          clarificationNeeded: discovery.clarificationNeeded,
        });
        return;
      }
      validatedPlan = await planner.createPlan(discovery, {
        conversationId: body.conversationId,
      });
    }

    if (!validatedPlan.valid) {
      res.status(400).json({
        error: 'Execution plan failed validation.',
        validationErrors: validatedPlan.validationErrors,
      });
      return;
    }

    const submitted = await getBackgroundOrchestrator().submitPlan(validatedPlan, {
      ownerId,
      idempotencyKey: body.idempotencyKey,
      timeoutMs: body.timeoutMs,
      taskClass: body.taskClass,
      priority: body.priority,
      approvedHighRisk: Boolean(body.approvedHighRisk),
    });

    res.status(202).json({
      taskId: submitted.taskId,
      status: submitted.status,
      deduplicated: submitted.deduplicated,
      plan: validatedPlan,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

taskRoutes.get('/', async (req: Request, res: Response) => {
  const ownerId = await resolveOwnerId(req);
  if (ownerId === 'unauthorized') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const limit = parseInt((req.query.limit as string) || '50', 10);
  const orchestrator = getBackgroundOrchestrator();
  const tasks = await orchestrator.listTasks(ownerId, limit);
  res.json({ tasks, resources: orchestrator.getResourceStatus() });
});

taskRoutes.get('/:id', async (req: Request, res: Response) => {
  const ownerId = await resolveOwnerId(req);
  const task = await getBackgroundOrchestrator().getTask(String(req.params.id), ownerId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json({ task });
});

taskRoutes.get('/:id/steps', async (req: Request, res: Response) => {
  const ownerId = await resolveOwnerId(req);
  const orchestrator = getBackgroundOrchestrator();
  const task = await orchestrator.getTask(String(req.params.id), ownerId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const steps = await orchestrator.getTaskSteps(task.id);
  res.json({ taskId: task.id, steps });
});

taskRoutes.get('/:id/events', async (req: Request, res: Response) => {
  const ownerId = await resolveOwnerId(req);
  const orchestrator = getBackgroundOrchestrator();
  const task = await orchestrator.getTask(String(req.params.id), ownerId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const events = await orchestrator.getTaskEvents(task.id);
  res.json({ taskId: task.id, events });
});

taskRoutes.post('/:id/cancel', async (req: Request, res: Response) => {
  const ownerId = await resolveOwnerId(req);
  try {
    const task = await getBackgroundOrchestrator().cancelTask(String(req.params.id), ownerId);
    res.json({ task });
  } catch (err) {
    if (err instanceof TaskConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    res.status(404).json({ error: (err as Error).message });
  }
});

taskRoutes.get('/:id/result', async (req: Request, res: Response) => {
  const ownerId = await resolveOwnerId(req);
  const orchestrator = getBackgroundOrchestrator();
  const task = await orchestrator.getTask(String(req.params.id), ownerId);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const steps = await orchestrator.getTaskSteps(task.id);
  res.json({
    taskId: task.id,
    status: task.status,
    progress: task.progress,
    resultSummary: task.resultSummary,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    steps,
  });
});
