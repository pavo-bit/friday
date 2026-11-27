// ============================================================
// FRIDAY — Web Research & Browser Intelligence Routes (Phase 14)
// ============================================================

import { Router, Request, Response } from 'express';
import { resolveCallerIdentity } from '../authContext';
import { getWebResearchEngine } from '../../research/researchEngine';
import { getContinuousLearningEngine } from '../../learning/learningEngine';

export const researchRoutes = Router();

// POST /friday/research/analyze — analyze a single website
researchRoutes.post('/analyze', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as {
      actorId?: string;
      conversationId?: string;
      url?: string;
      query?: string;
      maxDepth?: number;
      maxPages?: number;
      timeoutMs?: number;
    };
    if (!body.url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    const job = await getWebResearchEngine().analyzeWebsite({
      actorId: body.actorId || identity.actorId,
      conversationId: body.conversationId || 'default',
      url: body.url,
      query: body.query,
      maxDepth: body.maxDepth,
      maxPages: body.maxPages,
      timeoutMs: body.timeoutMs,
    });
    res.status(201).json({ job });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /friday/research/compare — compare multiple websites
researchRoutes.post('/compare', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as {
      actorId?: string;
      conversationId?: string;
      urls?: string[];
      query?: string;
      maxDepth?: number;
      maxPagesPerSite?: number;
      timeoutMs?: number;
    };
    if (!Array.isArray(body.urls) || body.urls.length < 2) {
      res.status(400).json({ error: 'At least 2 urls are required' });
      return;
    }
    const job = await getWebResearchEngine().compareWebsites({
      actorId: body.actorId || identity.actorId,
      conversationId: body.conversationId || 'default',
      urls: body.urls,
      query: body.query,
      maxDepth: body.maxDepth,
      maxPagesPerSite: body.maxPagesPerSite,
      timeoutMs: body.timeoutMs,
    });
    res.status(201).json({ job });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /friday/research/jobs — list research history
researchRoutes.get('/jobs', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const actorId = (req.query.actorId as string) || identity.actorId;
    const limit = parseInt((req.query.limit as string) || '20', 10);
    const jobs = await getWebResearchEngine().listJobs(actorId, limit);
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /friday/research/jobs/:id — get specific research job & report
researchRoutes.get('/jobs/:id', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const actorId = (req.query.actorId as string) || identity.actorId;
    const job = await getWebResearchEngine().getJob(String(req.params.id), actorId);
    if (!job) {
      res.status(404).json({ error: 'Research job not found' });
      return;
    }
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /friday/research/jobs/:id/cancel — cancel an active research job
researchRoutes.post('/jobs/:id/cancel', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const actorId = (req.body?.actorId as string) || identity.actorId;
    const cancelled = await getWebResearchEngine().cancelJob(String(req.params.id), actorId);
    res.status(cancelled ? 200 : 404).json({ cancelled });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /friday/research/jobs/:id/save-to-learning — cross-phase: save approved research evidence into Continuous Learning
researchRoutes.post('/jobs/:id/save-to-learning', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as { actorId?: string; projectName?: string };
    const actorId = body.actorId || identity.actorId;
    const job = await getWebResearchEngine().getJob(String(req.params.id), actorId);
    if (!job || !job.report) {
      res.status(404).json({ error: 'Completed research job not found' });
      return;
    }
    const result = await getContinuousLearningEngine().ingest({
      actorId,
      sourceType: 'approved_website',
      sourceRef: job.urls[0] || job.id,
      subject: `Web Research: ${job.query}`,
      rawContent: job.report.summary,
      projectName: body.projectName,
      declaredQuality: 'EXTERNAL_CLAIM',
      approvedSource: true,
    });
    res.status(result.ingested ? 201 : 400).json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
