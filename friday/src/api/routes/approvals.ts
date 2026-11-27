// ============================================================
// FRIDAY — API Routes: /friday/approvals/*
// Authenticated approval inspection, approval, rejection & cancellation
// ============================================================

import { Router } from 'express';
import { requireCallerIdentity } from '../authContext';
import { getSafetyGate } from '../../orchestration/safetyGate';
import { BoundApprovalStatus } from '../../orchestration/approvalStore';
import { getBackgroundOrchestrator } from '../../orchestration/backgroundOrchestrator';

export const approvalRoutes = Router();

/**
 * GET /friday/approvals
 * List approvals belonging to the authenticated actor/device.
 */
approvalRoutes.get('/', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;

  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : undefined;
  const status = typeof req.query.status === 'string' ? (req.query.status as BoundApprovalStatus) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 50;

  const approvals = await getSafetyGate().listBoundApprovals({
    actorId: identity.actorId,
    taskId,
    status,
    limit: Number.isFinite(limit) ? limit : 50,
  });

  res.json({ approvals });
});

/**
 * GET /friday/approvals/:id
 * Fetch a single approval record (enforces actor ownership).
 */
approvalRoutes.get('/:id', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;

  const approval = await getSafetyGate().getBoundApproval(req.params.id);
  if (!approval) {
    res.status(404).json({ error: 'Approval not found' });
    return;
  }

  if (approval.actorId !== identity.actorId) {
    res.status(403).json({ error: 'Forbidden: approval belongs to another actor' });
    return;
  }

  res.json({ approval });
});

/**
 * POST /friday/approvals/:id/approve
 * Approve a pending bound approval and resume the waiting background task.
 */
approvalRoutes.post('/:id/approve', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;

  const result = await getSafetyGate().resolveBoundApproval({
    approvalId: req.params.id,
    decision: 'APPROVE',
    actorId: identity.actorId,
    resolution: typeof req.body?.resolution === 'string' ? req.body.resolution : undefined,
  });

  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error, status: result.status });
    return;
  }

  let resumed = false;
  if (result.approval?.taskId) {
    const resumeRes = await getBackgroundOrchestrator().resumeAfterApproval(
      result.approval.taskId,
      result.approval.approvalId,
      identity.actorId
    );
    resumed = resumeRes.resumed;
  }

  res.json({ approval: result.approval, resumed });
});

/**
 * POST /friday/approvals/:id/reject
 * Reject a pending bound approval and fail/halt the waiting task cleanly.
 */
approvalRoutes.post('/:id/reject', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;

  const reason =
    typeof req.body?.reason === 'string'
      ? req.body.reason
      : typeof req.body?.resolution === 'string'
        ? req.body.resolution
        : 'Approval rejected by user';

  const result = await getSafetyGate().resolveBoundApproval({
    approvalId: req.params.id,
    decision: 'REJECT',
    actorId: identity.actorId,
    resolution: reason,
  });

  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error, status: result.status });
    return;
  }

  if (result.approval?.taskId && result.approval.stepId) {
    await getBackgroundOrchestrator().handleApprovalOutcome(
      result.approval.taskId,
      result.approval.stepId,
      'REJECTED',
      reason
    );
  }

  res.json({ approval: result.approval });
});

/**
 * POST /friday/approvals/:id/cancel
 * Cancel a pending bound approval.
 */
approvalRoutes.post('/:id/cancel', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;

  const reason =
    typeof req.body?.reason === 'string'
      ? req.body.reason
      : typeof req.body?.resolution === 'string'
        ? req.body.resolution
        : 'Approval cancelled by user';

  const result = await getSafetyGate().resolveBoundApproval({
    approvalId: req.params.id,
    decision: 'CANCEL',
    actorId: identity.actorId,
    resolution: reason,
  });

  if (!result.ok) {
    res.status(result.httpStatus).json({ error: result.error, status: result.status });
    return;
  }

  if (result.approval?.taskId && result.approval.stepId) {
    await getBackgroundOrchestrator().handleApprovalOutcome(
      result.approval.taskId,
      result.approval.stepId,
      'CANCELLED',
      reason
    );
  }

  res.json({ approval: result.approval });
});
