// ============================================================
// FRIDAY — Continuous Learning & Procedure Approval Routes (Phase 13)
// ============================================================

import { Router, Request, Response } from 'express';
import { resolveCallerIdentity } from '../authContext';
import { getContinuousLearningEngine } from '../../learning/learningEngine';
import { LearningKind, LearningSourceType, SourceQuality } from '../../learning/learningTypes';

export const learningRoutes = Router();

// POST /friday/learning/ingest — ingest approved learning input
learningRoutes.post('/ingest', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as {
      actorId?: string;
      sourceType?: LearningSourceType;
      sourceRef?: string;
      subject?: string;
      rawContent?: string;
      projectName?: string;
      explicitKind?: LearningKind;
      declaredQuality?: SourceQuality;
      approvedSource?: boolean;
      expiresAt?: string;
    };
    const actorId = body.actorId || identity.actorId;
    if (!body.sourceType || !body.subject || !body.rawContent) {
      res.status(400).json({ error: 'sourceType, subject, and rawContent are required' });
      return;
    }
    const result = await getContinuousLearningEngine().ingest({
      actorId,
      sourceType: body.sourceType,
      sourceRef: body.sourceRef || 'api',
      subject: body.subject,
      rawContent: body.rawContent,
      projectName: body.projectName,
      explicitKind: body.explicitKind,
      declaredQuality: body.declaredQuality,
      approvedSource: body.approvedSource,
      expiresAt: body.expiresAt,
    });
    res.status(result.ingested ? 201 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /friday/learning/records — retrieve learning records
learningRoutes.get('/records', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const actorId = (req.query.actorId as string) || identity.actorId;
    const kind = req.query.kind as LearningKind | undefined;
    const projectName = req.query.projectName as string | undefined;
    const query = req.query.query as string | undefined;
    const limit = parseInt((req.query.limit as string) || '25', 10);

    const records = await getContinuousLearningEngine().retrieve({
      actorId,
      kind,
      projectName,
      query,
      limit,
    });
    res.json({ records });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /friday/learning/correction — record explicit user correction
learningRoutes.post('/correction', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as {
      actorId?: string;
      subject?: string;
      correction?: string;
      projectName?: string;
    };
    const actorId = body.actorId || identity.actorId;
    if (!body.subject || !body.correction) {
      res.status(400).json({ error: 'subject and correction are required' });
      return;
    }
    const result = await getContinuousLearningEngine().recordCorrection({
      actorId,
      subject: body.subject,
      correction: body.correction,
      projectName: body.projectName,
    });
    res.status(result.storedInLearning ? 201 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /friday/learning/procedures — list proposed & approved procedures
learningRoutes.get('/procedures', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const actorId = (req.query.actorId as string) || identity.actorId;
    const procedures = await getContinuousLearningEngine().listProcedures(actorId);
    res.json({ procedures });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /friday/learning/procedures — propose a new learned procedure (unapproved by default)
learningRoutes.post('/procedures', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as {
      actorId?: string;
      name?: string;
      description?: string;
      steps?: string[];
    };
    const actorId = body.actorId || identity.actorId;
    if (!body.name || !body.description || !Array.isArray(body.steps)) {
      res.status(400).json({ error: 'name, description, and steps array are required' });
      return;
    }
    const procedure = await getContinuousLearningEngine().proposeProcedure({
      actorId,
      name: body.name,
      description: body.description,
      steps: body.steps,
    });
    res.status(201).json({ procedure });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /friday/learning/procedures/:id/approve — explicit human approval of procedure
learningRoutes.post('/procedures/:id/approve', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as { actorId?: string; approvedByHuman?: boolean };
    const actorId = body.actorId || identity.actorId;
    const procedure = await getContinuousLearningEngine().approveProcedure(
      actorId,
      String(req.params.id),
      Boolean(body.approvedByHuman)
    );
    res.json({ procedure });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
