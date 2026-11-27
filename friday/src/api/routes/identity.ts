// ============================================================
// FRIDAY — Personal Identity & Cross-Project Context Routes (Phase 13)
// ============================================================

import { Router, Request, Response } from 'express';
import { resolveCallerIdentity } from '../authContext';
import { getPersonalIdentityService } from '../../identity/identityService';
import { getProjectContextService } from '../../identity/projectContextService';
import { IdentityPolicyError } from '../../identity/identityPolicy';

export const identityRoutes = Router();

// GET /friday/identity — get personal identity profile + connected devices
identityRoutes.get('/', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const actorId = (req.query.actorId as string) || identity.actorId;
    const bundle = await getPersonalIdentityService().inspectIdentityBundle(actorId);
    res.json(bundle);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /friday/identity — create or update personal identity profile
identityRoutes.put('/', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const actorId = (body.actorId as string) || identity.actorId;
    const profile = await getPersonalIdentityService().createOrUpdateProfile(actorId, body);
    res.json({ profile });
  } catch (err) {
    const status = err instanceof IdentityPolicyError ? 400 : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

// GET /friday/identity/projects — list all projects for actor
identityRoutes.get('/projects', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const actorId = (req.query.actorId as string) || identity.actorId;
    const projects = await getProjectContextService().listProjects(actorId);
    const activeProject = projects.find((p) => p.isActive) || null;
    res.json({ projects, activeProject });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /friday/identity/projects — create or update a project context
identityRoutes.post('/projects', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const actorId = (body.actorId as string) || identity.actorId;
    if (!body.projectName || typeof body.projectName !== 'string') {
      res.status(400).json({ error: 'projectName is required' });
      return;
    }
    const project = await getProjectContextService().upsertProject(actorId, {
      projectName: body.projectName,
      repoPath: typeof body.repoPath === 'string' ? body.repoPath : undefined,
      techStack: Array.isArray(body.techStack) ? (body.techStack as string[]) : undefined,
      architectureSummary:
        typeof body.architectureSummary === 'string' ? body.architectureSummary : undefined,
      progressSummary: typeof body.progressSummary === 'string' ? body.progressSummary : undefined,
      blockers: Array.isArray(body.blockers) ? (body.blockers as string[]) : undefined,
      recentDecisions: Array.isArray(body.recentDecisions)
        ? (body.recentDecisions as string[])
        : undefined,
      docsPaths: Array.isArray(body.docsPaths) ? (body.docsPaths as string[]) : undefined,
      setActive: typeof body.setActive === 'boolean' ? body.setActive : undefined,
    });
    res.status(201).json({ project });
  } catch (err) {
    const status = err instanceof IdentityPolicyError ? 400 : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

// PUT /friday/identity/projects — alias for upsert
identityRoutes.put('/projects', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const actorId = (body.actorId as string) || identity.actorId;
    if (!body.projectName || typeof body.projectName !== 'string') {
      res.status(400).json({ error: 'projectName is required' });
      return;
    }
    const project = await getProjectContextService().upsertProject(actorId, {
      projectName: body.projectName,
      repoPath: typeof body.repoPath === 'string' ? body.repoPath : undefined,
      techStack: Array.isArray(body.techStack) ? (body.techStack as string[]) : undefined,
      architectureSummary:
        typeof body.architectureSummary === 'string' ? body.architectureSummary : undefined,
      progressSummary: typeof body.progressSummary === 'string' ? body.progressSummary : undefined,
      blockers: Array.isArray(body.blockers) ? (body.blockers as string[]) : undefined,
      recentDecisions: Array.isArray(body.recentDecisions)
        ? (body.recentDecisions as string[])
        : undefined,
      docsPaths: Array.isArray(body.docsPaths) ? (body.docsPaths as string[]) : undefined,
      setActive: typeof body.setActive === 'boolean' ? body.setActive : undefined,
    });
    res.json({ project });
  } catch (err) {
    const status = err instanceof IdentityPolicyError ? 400 : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

// POST /friday/identity/projects/switch — switch active project
identityRoutes.post('/projects/switch', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as { actorId?: string; projectName?: string };
    const actorId = body.actorId || identity.actorId;
    if (!body.projectName) {
      res.status(400).json({ error: 'projectName is required' });
      return;
    }
    const result = await getProjectContextService().switchProject(actorId, body.projectName);
    if (!result.switched || !result.project) {
      res.status(404).json({ error: result.message || `Project "${body.projectName}" not found` });
      return;
    }
    res.json({ activeProject: result.project, message: result.message });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /friday/identity/projects/compare — compare two projects
identityRoutes.post('/projects/compare', async (req: Request, res: Response) => {
  try {
    const identity = await resolveCallerIdentity(req);
    if (!identity) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const body = (req.body || {}) as { actorId?: string; projectA?: string; projectB?: string };
    const actorId = body.actorId || identity.actorId;
    if (!body.projectA || !body.projectB) {
      res.status(400).json({ error: 'projectA and projectB are required' });
      return;
    }
    const comparison = await getProjectContextService().compareProjects(
      actorId,
      body.projectA,
      body.projectB
    );
    res.json(comparison);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
