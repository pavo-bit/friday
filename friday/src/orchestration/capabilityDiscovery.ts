// ============================================================
// FRIDAY — Intelligent Capability Discovery Engine
// Resolves natural language + context into registered capabilities
// ============================================================

import {
  CapabilityDefinition,
  CapabilityRegistry,
  CapabilityRiskLevel,
  getCapabilityRegistry,
} from './toolRegistry';
import { getOllamaClient } from './ollamaClient';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('CapabilityDiscovery');

export interface DiscoveryPreviousResult {
  capabilityId: string;
  summary: string;
  data?: unknown;
}

export interface DiscoveryRequest {
  request: string;
  conversationId?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  previousResults?: DiscoveryPreviousResult[];
  userPermissions?: readonly string[];
  timezone?: string;
  useLlmFallback?: boolean;
}

export interface DiscoveredCapability {
  capability: CapabilityDefinition;
  matchReason: string;
  confidence: number;
  suggestedArguments: Record<string, unknown>;
  missingInputs: string[];
  clarificationQuestion?: string;
  available: boolean;
  unavailableReason?: string;
  dependsOn?: string[];
}

export interface UnavailableCapabilityInfo {
  capabilityId: string;
  name: string;
  reason: string;
}

export interface MissingInputInfo {
  capabilityId: string;
  fields: string[];
  clarificationQuestion: string;
}

export interface DiscoveryResult {
  request: string;
  normalizedIntent: string;
  requiresTools: boolean;
  isPureGreeting: boolean;
  hasCompoundGreeting: boolean;
  matched: DiscoveredCapability[];
  unavailable: UnavailableCapabilityInfo[];
  missingInputs: MissingInputInfo[];
  ambiguous: boolean;
  clarificationNeeded?: string;
  usedLlm: boolean;
}

const GREETING_PREFIX_RE =
  /^(?:(?:hi|hello|hey|good\s*(?:morning|afternoon|evening|night)|yo|greetings)(?:\s*,?\s*friday)?[!.,\s]*)(.*)$/i;

export class CapabilityDiscoveryEngine {
  constructor(private readonly registry: CapabilityRegistry = getCapabilityRegistry()) {}

  async discover(input: DiscoveryRequest): Promise<DiscoveryResult> {
    const raw = input.request.trim();
    const greetingMatch = raw.match(GREETING_PREFIX_RE);
    const hasCompoundGreeting = Boolean(greetingMatch && greetingMatch[1]?.trim().length >= 3);
    const isPureGreeting = Boolean(greetingMatch && (!greetingMatch[1] || greetingMatch[1].trim().length < 3));

    if (isPureGreeting) {
      return {
        request: raw,
        normalizedIntent: 'greeting',
        requiresTools: false,
        isPureGreeting: true,
        hasCompoundGreeting: false,
        matched: [],
        unavailable: [],
        missingInputs: [],
        ambiguous: false,
        usedLlm: false,
      };
    }

    const effectiveText = hasCompoundGreeting ? greetingMatch![1].trim() : raw;
    const clauses = this.splitClauses(effectiveText);
    const matched: DiscoveredCapability[] = [];
    const unavailable: UnavailableCapabilityInfo[] = [];
    const missingInputs: MissingInputInfo[] = [];
    const seenIds = new Set<string>();

    // Check follow-up references ("compare that", "with last month", "tell me more about it")
    if (this.isFollowUpReference(effectiveText)) {
      const hasContext =
        (input.previousResults && input.previousResults.length > 0) ||
        (input.conversationHistory && input.conversationHistory.length > 0);
      if (!hasContext) {
        return {
          request: raw,
          normalizedIntent: effectiveText,
          requiresTools: true,
          isPureGreeting: false,
          hasCompoundGreeting,
          matched: [],
          unavailable: [],
          missingInputs: [],
          ambiguous: true,
          clarificationNeeded:
            'I do not have a previous result in this conversation to compare against. What would you like me to check first?',
          usedLlm: false,
        };
      }
    }

    // 1. Deterministic clause-by-clause capability matching
    for (const clause of clauses) {
      const candidate = this.matchDeterministicClause(clause, input);
      if (!candidate) continue;

      if (seenIds.has(candidate.capability.id)) continue;
      seenIds.add(candidate.capability.id);

      const avail = await this.safeCheckAvailability(candidate.capability);
      if (!avail.available) {
        unavailable.push({
          capabilityId: candidate.capability.id,
          name: candidate.capability.name,
          reason: avail.reason || `${candidate.capability.name} is currently unavailable.`,
        });
        continue;
      }

      if (candidate.missingInputs.length > 0) {
        missingInputs.push({
          capabilityId: candidate.capability.id,
          fields: candidate.missingInputs,
          clarificationQuestion:
            candidate.clarificationQuestion ||
            `Please provide ${candidate.missingInputs.join(', ')} for ${candidate.capability.name}.`,
        });
      }

      matched.push({
        ...candidate,
        available: true,
      });
    }

    // 2. Metadata keyword discovery if deterministic rules found nothing
    if (matched.length === 0 && unavailable.length === 0) {
      const metaHits = await this.registry.discover({
        query: effectiveText,
        includeDisabled: false,
        onlyAvailable: false,
      });

      // Only accept strong metadata match if query explicitly names a capability ID/name
      for (const cap of metaHits) {
        const lower = effectiveText.toLowerCase();
        if (lower.includes(cap.id.toLowerCase()) || lower.includes(cap.name.toLowerCase())) {
          const avail = await this.safeCheckAvailability(cap);
          if (!avail.available) {
            unavailable.push({
              capabilityId: cap.id,
              name: cap.name,
              reason: avail.reason || `${cap.name} is unavailable.`,
            });
          } else {
            matched.push({
              capability: cap,
              matchReason: `Matched capability identifier "${cap.name}"`,
              confidence: 0.9,
              suggestedArguments: {},
              missingInputs: [],
              available: true,
            });
          }
        }
      }
    }

    // 3. Optional local Ollama discovery fallback for complex multi-step requests
    let usedLlm = false;
    if (matched.length === 0 && unavailable.length === 0 && input.useLlmFallback !== false) {
      const llmDiscovered = await this.discoverWithOllama(effectiveText);
      if (llmDiscovered.usedLlm) {
        usedLlm = true;
        for (const item of llmDiscovered.items) {
          if (seenIds.has(item.capability.id)) continue;
          seenIds.add(item.capability.id);
          const avail = await this.safeCheckAvailability(item.capability);
          if (!avail.available) {
            unavailable.push({
              capabilityId: item.capability.id,
              name: item.capability.name,
              reason: avail.reason || `${item.capability.name} is unavailable.`,
            });
          } else {
            matched.push({ ...item, available: true });
          }
        }
      }
    }

    const clarificationNeeded =
      missingInputs.length > 0
        ? missingInputs.map((m) => m.clarificationQuestion).join(' ')
        : unavailable.length > 0 && matched.length === 0
        ? `Requested capability is unavailable: ${unavailable.map((u) => `${u.name} (${u.reason})`).join('; ')}`
        : undefined;

    return {
      request: raw,
      normalizedIntent: effectiveText,
      requiresTools: matched.length > 0 || unavailable.length > 0 || missingInputs.length > 0,
      isPureGreeting: false,
      hasCompoundGreeting,
      matched,
      unavailable,
      missingInputs,
      ambiguous: missingInputs.length > 0,
      clarificationNeeded,
      usedLlm,
    };
  }

  private splitClauses(text: string): string[] {
    return text
      .split(/\s*(?:\band\b|\bthen\b|,)\s*/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private isFollowUpReference(text: string): boolean {
    return /\b(compare\s+that|that\s+with\s+last\s+month|those\s+results|do\s+the\s+same)\b/i.test(text);
  }

  private matchDeterministicClause(
    clause: string,
    input: DiscoveryRequest
  ): Omit<DiscoveredCapability, 'available'> | null {
    const lower = clause.toLowerCase();

    // Financial Intelligence deterministic discovery
    if (/\b(cash\s*flow|how\s+much\s+did\s+i\s+spend|monthly\s+spending|income\s+and\s+expense)\b/i.test(lower)) {
      const cap = this.registry.get('finance.cash_flow');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Cash flow / spending inquiry matched finance.cash_flow',
          confidence: 0.94,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }
    if (/\b(budget\s+utilization|over\s+budget)\b/i.test(lower) || (/\bbudget\b/i.test(lower) && !/\brisk\s+budget\b/i.test(lower))) {
      const cap = this.registry.get('finance.budget_status');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Budget inquiry matched finance.budget_status',
          confidence: 0.93,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }
    if (/\b(savings?\s*goal|save\s+for\s+my\s+goal|financial\s*goal)\b/i.test(lower)) {
      const cap = this.registry.get('finance.goal_progress');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Savings goal inquiry matched finance.goal_progress',
          confidence: 0.93,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }
    if (/\b(portfolio|asset\s+allocation|holdings|concentration\s+risk)\b/i.test(lower)) {
      const cap = this.registry.get('finance.portfolio_analyze');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Portfolio inquiry matched finance.portfolio_analyze',
          confidence: 0.93,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }
    if (/\b(repayment\s+scenario|debt\s+scenario|debt\s+repayment)\b/i.test(lower)) {
      const cap = this.registry.get('finance.debt_scenario');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Debt scenario inquiry matched finance.debt_scenario',
          confidence: 0.9,
          suggestedArguments: {},
          missingInputs: ['remaining', 'aprPct', 'paymentA', 'paymentB'],
          clarificationQuestion: 'Please provide remaining balance, APR %, and the two monthly payment amounts to compare.',
        };
      }
    }
    if (/\b(financial\s+(report|overview|summary)|net\s+worth)\b/i.test(lower)) {
      const cap = this.registry.get('finance.report');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Financial overview inquiry matched finance.report',
          confidence: 0.92,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }

    // Trading Copilot deterministic discovery
    if (/\b(remaining\s+risk\s+budget|risk\s+budget|trading\s+capital)\b/i.test(lower)) {
      const cap = this.registry.get('trading.risk_budget');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Risk budget inquiry matched trading.risk_budget',
          confidence: 0.94,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }
    if (/\b(trading\s+journal|review\s+my\s+trading\s+journal|trade\s+journal)\b/i.test(lower)) {
      const cap = this.registry.get('trading.journal_review');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Trading journal inquiry matched trading.journal_review',
          confidence: 0.94,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }
    if (/\b(backtest|back-test)\b/i.test(lower)) {
      const cap = this.registry.get('trading.backtest');
      if (cap && cap.enabled) {
        const symMatch = clause.match(/\b([A-Z]{2,12})\b/);
        return {
          capability: cap,
          matchReason: 'Backtest inquiry matched trading.backtest',
          confidence: 0.9,
          suggestedArguments: symMatch ? { symbol: symMatch[1], strategyId: 'vwap_trend_continuation' } : {},
          missingInputs: symMatch ? [] : ['symbol', 'strategyId'],
          clarificationQuestion: symMatch ? undefined : 'Which NSE/BSE symbol and strategy would you like to backtest?',
        };
      }
    }
    if (/\b(position\s+size|calculate\s+position\s+size)\b/i.test(lower)) {
      const cap = this.registry.get('trading.position_size');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Position size inquiry matched trading.position_size',
          confidence: 0.9,
          suggestedArguments: {},
          missingInputs: ['symbol', 'direction', 'entryPrice', 'stopLoss', 'target'],
          clarificationQuestion: 'Please provide symbol, direction, entryPrice, stopLoss, and target.',
        };
      }
    }
    if (/\b(analyze\s+(?:this\s+)?stock|intraday\s+setups?|find\s+intraday\s+setups?)\b/i.test(lower)) {
      const cap = this.registry.get('trading.analyze_stock');
      if (cap && cap.enabled) {
        const symMatch = clause.match(/\b([A-Z]{2,12})\b/);
        return {
          capability: cap,
          matchReason: 'Stock analysis inquiry matched trading.analyze_stock',
          confidence: 0.9,
          suggestedArguments: symMatch ? { symbol: symMatch[1] } : {},
          missingInputs: symMatch ? [] : ['symbol'],
          clarificationQuestion: symMatch ? undefined : 'Which NSE/BSE stock symbol would you like me to analyze?',
        };
      }
    }

    // Time / Date
    if (/\b(what\s*(time|day|date)|current\s*(time|date)|time\s*right\s*now)\b/i.test(lower)) {
      const cap = this.registry.get('get_current_time');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Time/date inquiry matched get_current_time',
          confidence: 0.95,
          suggestedArguments: input.timezone ? { timezone: input.timezone } : {},
          missingInputs: [],
        };
      }
    }

    // Ollama status
    if (/\b(check\s+ollama|ollama\s+status)\b/i.test(lower)) {
      const cap = this.registry.get('check_ollama_status');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Ollama status check matched check_ollama_status',
          confidence: 0.95,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }

    // System / Laptop health status
    if (/\b(system\s*status|laptop\s*health|server\s*status|health\s*check|status\s*check)\b/i.test(lower)) {
      const urlMatch = clause.match(/https?:\/\/\S+/i);
      if (urlMatch) {
        const cap = this.registry.get('check_server_health');
        if (cap && cap.enabled) {
          return {
            capability: cap,
            matchReason: 'URL health probe matched check_server_health',
            confidence: 0.92,
            suggestedArguments: { url: urlMatch[0] },
            missingInputs: [],
          };
        }
      }
      const cap = this.registry.get('get_system_status');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'System health inquiry matched get_system_status',
          confidence: 0.93,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }

    // Monitoring commands
    if (/\b(pause)\b.*\b(monitor|monitoring|watch|watcher|dashboard)\b/i.test(lower)) {
      const cap = this.registry.get('pause_dashboard_watch');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Pause monitoring command',
          confidence: 0.9,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }
    if (/\b(resume)\b.*\b(monitor|monitoring|watch|watcher|dashboard)\b/i.test(lower)) {
      const cap = this.registry.get('resume_dashboard_watch');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Resume monitoring command',
          confidence: 0.9,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }
    if (/\b(stop)\b.*\b(monitor|monitoring|watch|watching|watcher|dashboard)\b/i.test(lower)) {
      const cap = this.registry.get('stop_dashboard_watch');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'Stop monitoring command',
          confidence: 0.9,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }
    if (/\b(what\s+are\s+you\s+monitoring|list\s+watchers|active\s+watchers|monitoring\s+status)\b/i.test(lower)) {
      const cap = this.registry.get('list_dashboard_watchers');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'List watchers command',
          confidence: 0.9,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }
    if (/\b(watch|monitor)\b.*\b(dashboard|server|website|endpoint|erp)\b/i.test(lower)) {
      const cap = this.registry.get('start_dashboard_watch');
      if (cap && cap.enabled) {
        const urlMatch = clause.match(/https?:\/\/\S+/i);
        return {
          capability: cap,
          matchReason: 'Start monitoring command',
          confidence: 0.9,
          suggestedArguments: { targetUrl: urlMatch?.[0] || '' },
          missingInputs: [],
        };
      }
    }

    // Reminders: detect missing date/time instead of inventing it!
    const remMatch = clause.match(/remind\s+me\s+(?:to\s+)?(.+)/i);
    if (remMatch) {
      const cap = this.registry.get('create_reminder');
      if (cap && cap.enabled) {
        const body = remMatch[1].trim();
        const hasTimeOrLoc = /\b(at|on|in|tomorrow|every|when\s+i\s+(?:reach|arrive))\b/i.test(body);
        if (!hasTimeOrLoc) {
          const cleanTitle = body.replace(/[.!?]+$/, '').trim();
          return {
            capability: cap,
            matchReason: 'Reminder request missing schedule/location',
            confidence: 0.88,
            suggestedArguments: { title: cleanTitle },
            missingInputs: ['dueAt'],
            clarificationQuestion: `When should I remind you to "${cleanTitle}"?`,
          };
        }
      }
    }

    if (/\b(list|show|what\s+are\s+my)\b.*\b(reminders|alarms)\b/i.test(lower)) {
      const cap = this.registry.get('list_reminders');
      if (cap && cap.enabled) {
        return {
          capability: cap,
          matchReason: 'List reminders inquiry',
          confidence: 0.9,
          suggestedArguments: {},
          missingInputs: [],
        };
      }
    }

    return null;
  }

  private async safeCheckAvailability(
    cap: CapabilityDefinition
  ): Promise<{ available: boolean; reason?: string }> {
    try {
      return await cap.isAvailable();
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  }

  private async discoverWithOllama(
    text: string
  ): Promise<{ usedLlm: boolean; items: Array<Omit<DiscoveredCapability, 'available'>> }> {
    const ollama = getOllamaClient();
    const status = await ollama.checkStatus(800);
    if (!status.reachable || !status.modelAvailable) {
      return { usedLlm: false, items: [] };
    }

    const catalog = this.registry.listEnabled().map((c) => ({
      id: c.id,
      name: c.name,
      category: c.category,
      description: c.description,
    }));

    const prompt = [
      'Select only registered capability IDs needed for the user request.',
      'Return JSON: {"capabilities":[{"id":"...","arguments":{},"dependsOn":[]}]}',
      `Available capabilities: ${JSON.stringify(catalog)}`,
      `User request: ${text}`,
    ].join('\n');

    const res = await ollama.chat({
      messages: [{ role: 'user', content: prompt }],
      timeoutMs: 8_000,
    });

    if (!res.ok || !res.content) {
      return { usedLlm: true, items: [] };
    }

    try {
      const jsonMatch = res.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { usedLlm: true, items: [] };
      const parsed = JSON.parse(jsonMatch[0]) as {
        capabilities?: Array<{ id?: string; arguments?: Record<string, unknown>; dependsOn?: string[] }>;
      };
      const items: Array<Omit<DiscoveredCapability, 'available'>> = [];
      for (const entry of parsed.capabilities || []) {
        if (!entry.id) continue;
        const cap = this.registry.get(entry.id);
        if (!cap || !cap.enabled) continue;
        items.push({
          capability: cap,
          matchReason: 'Proposed by local Ollama discovery',
          confidence: 0.75,
          suggestedArguments: entry.arguments && typeof entry.arguments === 'object' ? entry.arguments : {},
          missingInputs: [],
          dependsOn: Array.isArray(entry.dependsOn) ? entry.dependsOn : [],
        });
      }
      return { usedLlm: true, items };
    } catch (err) {
      log.warn('Failed to parse Ollama discovery JSON', { error: (err as Error).message });
      return { usedLlm: true, items: [] };
    }
  }
}

let _discovery: CapabilityDiscoveryEngine | null = null;
export function getCapabilityDiscoveryEngine(): CapabilityDiscoveryEngine {
  if (!_discovery) {
    _discovery = new CapabilityDiscoveryEngine();
  }
  return _discovery;
}
