// ============================================================
// FRIDAY — Web Research Capabilities (Phase 14)
// ============================================================

import { CapabilityRegistry } from '../orchestration/toolRegistry';
import { getWebResearchEngine } from './researchEngine';
import { getBrowserAdapter } from './browserAdapter';

export function registerResearchCapabilities(registry: CapabilityRegistry): void {
  registry.register({
    id: 'core.research.analyze_website',
    name: 'analyze_website',
    description: 'Investigate a publicly accessible website and produce an evidence-backed research report.',
    category: 'research',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['read:web'],
    timeoutMs: 25_000,
    trusted: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        query: { type: 'string' },
        maxDepth: { type: 'number' },
        maxPages: { type: 'number' },
      },
      required: ['url'],
    },
    outputSchema: { type: 'object' },
    validate: (args) => {
      if (typeof args.url !== 'string' || !args.url.trim()) return 'url is required';
      try {
        getBrowserAdapter().validatePublicUrl(args.url);
      } catch (err) {
        return (err as Error).message;
      }
      return null;
    },
    execute: async (args, ctx) => {
      const job = await getWebResearchEngine().analyzeWebsite({
        actorId: ctx.actor || 'local',
        url: String(args.url),
        query: typeof args.query === 'string' ? args.query : undefined,
        maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : 1,
        maxPages: typeof args.maxPages === 'number' ? args.maxPages : 5,
      });
      return {
        verified: job.status === 'COMPLETED',
        data: job,
        message: job.report?.summary || `Research job ${job.id} finished with status ${job.status}.`,
      };
    },
  });

  registry.register({
    id: 'core.research.compare_websites',
    name: 'compare_websites',
    description: 'Compare two or more publicly accessible websites with cross-checked evidence.',
    category: 'research',
    version: '1.0.0',
    riskLevel: 'low',
    permissions: ['read:web'],
    timeoutMs: 30_000,
    trusted: true,
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' } },
        query: { type: 'string' },
        maxDepth: { type: 'number' },
        maxPagesPerSite: { type: 'number' },
      },
      required: ['urls'],
    },
    outputSchema: { type: 'object' },
    validate: (args) => {
      if (!Array.isArray(args.urls) || args.urls.length < 2) {
        return 'At least 2 URLs are required';
      }
      for (const u of args.urls) {
        if (typeof u !== 'string') return 'Each URL must be a string';
        try {
          getBrowserAdapter().validatePublicUrl(u);
        } catch (err) {
          return (err as Error).message;
        }
      }
      return null;
    },
    execute: async (args, ctx) => {
      const job = await getWebResearchEngine().compareWebsites({
        actorId: ctx.actor || 'local',
        urls: (args.urls as string[]).map(String),
        query: typeof args.query === 'string' ? args.query : undefined,
        maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : 1,
        maxPagesPerSite: typeof args.maxPagesPerSite === 'number' ? args.maxPagesPerSite : 3,
      });
      return {
        verified: job.status === 'COMPLETED',
        data: job,
        message: job.report?.summary || `Comparison job ${job.id} finished with status ${job.status}.`,
      };
    },
  });

  registry.register({
    id: 'core.research.submit_web_action',
    name: 'submit_web_action',
    description: 'Perform a consequential web action (form submission, publish, or purchase). Requires explicit human approval.',
    category: 'research',
    version: '1.0.0',
    riskLevel: 'high',
    permissions: ['write:web'],
    timeoutMs: 10_000,
    trusted: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        actionType: { type: 'string', enum: ['submit_form', 'publish', 'purchase'] },
        payloadSummary: { type: 'string' },
      },
      required: ['url', 'actionType'],
    },
    outputSchema: { type: 'object' },
    validate: (args) => {
      if (typeof args.url !== 'string' || !args.url.trim()) return 'url is required';
      if (!['submit_form', 'publish', 'purchase'].includes(String(args.actionType))) {
        return 'actionType must be submit_form, publish, or purchase';
      }
      return null;
    },
    execute: async (args, ctx) => {
      if (!ctx.approvedHighRisk) {
        return {
          verified: false,
          data: { requiresApproval: true },
          message: `Blocked consequential web action (${String(args.actionType)}) on ${String(args.url)}: explicit human approval is required.`,
        };
      }
      return {
        verified: true,
        data: { url: args.url, actionType: args.actionType, approved: true },
        message: `Approved consequential web action "${String(args.actionType)}" recorded for ${String(args.url)}.`,
      };
    },
  });
}
