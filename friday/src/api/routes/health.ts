// ============================================================
// FRIDAY — API Routes: /friday/health
// System health and status endpoints
// ============================================================

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import { getConfig } from '../../shared/config';
import { getClawBridge } from '../../orchestration/clawBridge';
import { getSafetyGate } from '../../orchestration/safetyGate';
import { getTaskRouter } from '../../orchestration/taskRouter';
import { eventBus } from '../../shared/events';
import { getStt } from '../../voice/stt';
import { getTts } from '../../voice/tts';

export const healthRoutes = Router();

/**
 * GET /friday/health
 * Comprehensive system health check.
 */
healthRoutes.get('/health', async (_req: Request, res: Response) => {
  const config = getConfig();
  const bridge = getClawBridge();
  const stt = getStt();
  const tts = getTts();

  const clawAvailable = bridge.isAvailable();

  res.json({
    status: clawAvailable ? 'ok' : 'degraded',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),

    subsystems: {
      claw: {
        status: clawAvailable ? 'online' : 'offline',
        binary: bridge.getBinaryPath(),
        exists: clawAvailable,
        activeProcesses: bridge.getActiveCount(),
        totalInvocations: bridge.getTotalInvocations(),
      },
      voice: {
        stt: {
          engine: config.sttEngine,
          available: stt.isAvailable(),
        },
        tts: {
          engine: config.ttsEngine,
          available: tts.isAvailable(),
        },
      },
      safety: {
        requireApproval: config.requireHighRiskApproval,
        rateLimitPerMinute: config.rateLimitPerMinute,
        highRiskLimitPerHour: config.highRiskLimitPerHour,
        pendingApprovals: getSafetyGate().getPendingApprovals().length,
      },
      memory: {
        dbPath: config.dbPath,
        dbExists: fs.existsSync(config.dbPath),
      },
      ai: {
        provider: 'openrouter',
        configured: Boolean(config.openrouterApiKey && config.openrouterModel),
        model: config.openrouterModel || null,
        baseUrl: config.openrouterBaseUrl,
      },
      control: {
        browserEnabled: config.enableBrowserControl,
        pcEnabled: config.enablePcControl,
      },
    },

    events: eventBus.getStats(),
  });
});

/**
 * GET /friday/status
 * Lightweight status check (for monitoring).
 */
healthRoutes.get('/status', async (_req: Request, res: Response) => {
  const bridge = getClawBridge();
  res.json({
    ok: true,
    claw: bridge.isAvailable(),
    uptime: Math.floor(process.uptime()),
  });
});
