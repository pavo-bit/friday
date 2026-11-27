// ============================================================
// FRIDAY — API Routes: Presentations
// Authenticated presentation retrieval with ownership enforcement
// ============================================================

import { Router } from 'express';
import { requireCallerIdentity } from '../authContext';
import { getDisplayManager } from '../../presentation/displayManager';
import { getBackgroundOrchestrator } from '../../orchestration/backgroundOrchestrator';

export const presentationRoutes = Router();

/**
 * GET /friday/presentations
 * List presentations belonging to the authenticated caller.
 */
presentationRoutes.get('/presentations', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;

  const conversationId =
    typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : 30;

  const presentations = await getDisplayManager().listPresentations(identity.actorId, {
    conversationId,
    limit: Number.isFinite(limit) ? limit : 30,
  });

  res.json({ presentations });
});

/**
 * GET /friday/presentations/:id
 * Fetch a single presentation (enforces ownership).
 */
presentationRoutes.get('/presentations/:id', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;

  const result = await getDisplayManager().getPresentation(req.params.id, identity.actorId);
  if (!result.found) {
    res.status(404).json({ error: 'Presentation not found' });
    return;
  }
  if (result.forbidden) {
    res.status(403).json({ error: 'Forbidden: presentation belongs to another actor' });
    return;
  }

  res.json({ presentation: result.presentation });
});

/**
 * GET /friday/tasks/:id/presentation
 * Fetch the presentation associated with a background task (enforces task & presentation ownership).
 */
presentationRoutes.get('/tasks/:id/presentation', async (req, res) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;

  const task = await getBackgroundOrchestrator().getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.ownerId !== identity.actorId) {
    res.status(403).json({ error: 'Forbidden: task belongs to another actor' });
    return;
  }

  const result = await getDisplayManager().getTaskPresentation(req.params.id, identity.actorId);
  if (!result.found) {
    res.status(404).json({ error: 'Presentation not yet generated for this task' });
    return;
  }
  if (result.forbidden) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  res.json({ presentation: result.presentation });
});
