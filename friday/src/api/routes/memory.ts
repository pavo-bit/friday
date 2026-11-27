// ============================================================
// FRIDAY — API Routes: /friday/memory/*
// Memory management endpoints
// ============================================================

import { Router, Request, Response } from 'express';
import { getMemoryStore } from '../../memory/store';
import { requireCallerIdentity } from '../authContext';

export const memoryRoutes = Router();

memoryRoutes.use(async (req, res, next) => {
  const identity = await requireCallerIdentity(req, res);
  if (!identity) return;
  next();
});

/**
 * POST /friday/memory/store
 * Store a new memory entry.
 */
memoryRoutes.post('/store', async (req: Request, res: Response) => {
  const { type, key, value, metadata } = req.body as {
    type?: string;
    key?: string;
    value?: string;
    metadata?: Record<string, string>;
  };

  if (!type || !key || !value) {
    res.status(400).json({ error: 'Missing required fields: type, key, value' });
    return;
  }

  const validTypes = ['conversation', 'task', 'preference', 'contact', 'fact'];
  if (!validTypes.includes(type)) {
    res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
    return;
  }

  const store = await getMemoryStore();
  const id = store.store(type as any, key, value, metadata || {});
  res.json({ id, stored: true });
});

/**
 * GET /friday/memory/search?q=<query>
 * Search memories using keyword matching.
 */
memoryRoutes.get('/search', async (req: Request, res: Response) => {
  const query = req.query.q as string;
  const limit = parseInt((req.query.limit as string) || '10', 10);

  if (!query) {
    res.status(400).json({ error: 'Missing query parameter "q"' });
    return;
  }

  const store = await getMemoryStore();
  const results = store.search(query, limit);
  res.json({ results, count: results.length });
});

/**
 * GET /friday/memory/retrieve?type=<type>&key=<pattern>
 * Retrieve memories by type and/or key pattern.
 */
memoryRoutes.get('/retrieve', async (req: Request, res: Response) => {
  const type = req.query.type as string | undefined;
  const keyPattern = req.query.key as string | undefined;
  const limit = parseInt((req.query.limit as string) || '20', 10);

  const store = await getMemoryStore();
  const results = store.retrieve(type as any, keyPattern, limit);
  res.json({ results, count: results.length });
});

/**
 * GET /friday/memory/conversations
 * Get recent conversation history.
 */
memoryRoutes.get('/conversations', async (req: Request, res: Response) => {
  const limit = parseInt((req.query.limit as string) || '50', 10);
  const sessionId = req.query.session as string | undefined;

  const store = await getMemoryStore();
  const conversations = store.getRecentConversations(limit, sessionId);
  res.json({ conversations, count: conversations.length });
});

/**
 * GET /friday/memory/stats
 * Get memory store statistics.
 */
memoryRoutes.get('/stats', async (_req: Request, res: Response) => {
  const store = await getMemoryStore();
  res.json(store.getStats());
});

/**
 * PUT /friday/memory/:id
 * Update a specific memory entry.
 */
memoryRoutes.put('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { value } = req.body as { value?: string };
  if (!value || typeof value !== 'string') {
    res.status(400).json({ error: 'Missing "value" string' });
    return;
  }
  try {
    const store = await getMemoryStore();
    const updated = store.updateMemory(id, value);
    if (!updated) {
      res.status(404).json({ error: 'Memory not found' });
      return;
    }
    res.json({ updated: true, id });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * DELETE /friday/memory/:id
 * Delete a specific memory entry.
 */
memoryRoutes.delete('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const store = await getMemoryStore();
  const deleted = store.deleteMemory(id);
  if (!deleted) {
    res.status(404).json({ error: 'Memory not found' });
    return;
  }
  res.json({ deleted: true, id });
});

/**
 * POST /friday/memory/prune
 * Prune memories older than retentionDays.
 */
memoryRoutes.post('/prune', async (req: Request, res: Response) => {
  const { retentionDays = 30 } = req.body as { retentionDays?: number };
  const store = await getMemoryStore();
  const pruned = store.pruneMemories(Number(retentionDays));
  res.json({ pruned, retentionDays });
});
