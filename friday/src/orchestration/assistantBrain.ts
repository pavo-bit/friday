// ============================================================
// FRIDAY — Assistant Brain
// Integrates Personality, Memory Context, Ollama Tool Calling,
// and Deterministic Natural-Language Action Dispatch
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { getPersonalityEngine } from '../intelligence/personality';
import { getOllamaClient, OllamaChatMessage } from './ollamaClient';
import { getToolRegistry, ToolExecutionResult } from './toolRegistry';
import { getCapabilityDiscoveryEngine } from './capabilityDiscovery';
import { getToolPlanner, ExecutionPlan } from './toolPlanner';
import { getMonitoringEngine } from '../services/monitoringEngine';
import { getSchedulerService } from '../services/schedulerService';
import { getIntentParser } from '../intelligence/intentParser';
import { getTaskRouter } from './taskRouter';
import { ActionType, RiskLevel, TaskResult } from '../shared/types';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('AssistantBrain');

export class AssistantBrain {
  /**
   * Process natural-language input through the full FRIDAY lifecycle:
   * Context load -> Deterministic tool / NLU match OR Ollama tool-calling ->
   * Verified execution -> Personality formatting -> Memory logging.
   */
  async process(
    text: string,
    sessionId?: string,
    approvedHighRisk = false
  ): Promise<TaskResult & { toolResult?: ToolExecutionResult; plan?: ExecutionPlan }> {
    const startTime = Date.now();
    const intentId = uuidv4();
    const store = await getMemoryStore();
    const personality = getPersonalityEngine();
    const profile = store.getPersonalityProfile();
    const registry = getToolRegistry();
    const trimmed = text.trim();

    store.logConversation('user', trimmed, undefined, sessionId);

    // 1. Greetings, Compound Greeting+Command requests & Farewells
    const greetingPrefixMatch = trimmed.match(
      /^(?:(?:hi|hello|hey|good\s*(?:morning|afternoon|evening|night)|yo|greetings)(?:\s*,?\s*friday)?[!.,\s]*)(.*)$/i
    );
    if (greetingPrefixMatch) {
      const remainder = (greetingPrefixMatch[1] || '').trim();
      const watchers = await getMonitoringEngine().listWatchers();
      const unhealthy = watchers.filter(
        (w) => w.status === 'active' && (w.health === 'offline' || w.health === 'degraded')
      ).length;
      const pendingReminders = (await getSchedulerService().listReminders('pending')).length;
      const ollama = await getOllamaClient().checkStatus(1_000);

      const greetingText = personality.buildGreeting(profile, {
        pendingRemindersCount: pendingReminders,
        unhealthyWatchersCount: unhealthy,
        allSystemsHealthy: unhealthy === 0 && ollama.reachable,
      });

      // Pure greeting -> return greeting directly
      if (!remainder || remainder.length < 3) {
        return this.finish(intentId, trimmed, greetingText, true, 'internal', RiskLevel.LOW, startTime, sessionId);
      }

      // Compound request ("Good morning FRIDAY, what is my system status?")
      const compoundTool = this.matchDirectTool(remainder, profile.timezone);
      if (compoundTool) {
        const toolRes = await registry.execute(compoundTool.tool, compoundTool.args, {
          actor: 'user',
          approvedHighRisk,
          timezone: profile.timezone,
        });
        const actionText = toolRes.success
          ? personality.formatVerifiedSuccess(toolRes.message, toolRes.verified)
          : personality.formatFailure(toolRes.error || toolRes.message);
        const combined = `${greetingText}\n\n${actionText}`;
        const res = await this.finish(
          intentId,
          trimmed,
          combined,
          toolRes.success,
          'internal',
          RiskLevel.LOW,
          startTime,
          sessionId
        );
        return { ...res, toolResult: toolRes };
      }
    }

    if (/^(bye|goodbye|see\s*you|good\s*night)\b/i.test(trimmed) && trimmed.length < 40) {
      const output = personality.buildFarewell(profile, trimmed);
      return this.finish(intentId, trimmed, output, true, 'internal', RiskLevel.LOW, startTime, sessionId);
    }

    // 1.5 Structured Capability Discovery & Multi-Tool Planning (deterministic fast path)
    const discovery = await getCapabilityDiscoveryEngine().discover({
      request: trimmed,
      conversationId: sessionId,
      conversationHistory: store.getRecentConversations(6, sessionId),
      timezone: profile.timezone,
      useLlmFallback: false,
    });

    if (discovery.clarificationNeeded && discovery.matched.length <= 1) {
      return this.finish(
        intentId,
        trimmed,
        discovery.clarificationNeeded,
        false,
        'internal',
        RiskLevel.LOW,
        startTime,
        sessionId
      );
    }

    if (discovery.matched.length > 1) {
      const plan = await getToolPlanner().createPlan(discovery, { conversationId: sessionId });
      if (!plan.valid) {
        const errMsg = plan.clarificationNeeded || plan.validationErrors.join(' ');
        const res = await this.finish(
          intentId,
          trimmed,
          personality.formatFailure(errMsg),
          false,
          'internal',
          RiskLevel.LOW,
          startTime,
          sessionId
        );
        return { ...res, plan };
      }

      const outputs: string[] = [];
      let allOk = true;
      let lastToolResult: ToolExecutionResult | undefined;

      for (const group of plan.parallelGroups) {
        const groupSteps = group
          .map((sid) => plan.steps.find((s) => s.stepId === sid))
          .filter((s): s is NonNullable<typeof s> => Boolean(s));

        const results = await Promise.all(
          groupSteps.map((step) =>
            registry.execute(step.capabilityId, step.arguments, {
              actor: 'user',
              approvedHighRisk,
              timezone: profile.timezone,
            })
          )
        );

        for (const r of results) {
          lastToolResult = r;
          if (!r.success) allOk = false;
          outputs.push(r.message);
        }
      }

      const res = await this.finish(
        intentId,
        trimmed,
        outputs.join('\n'),
        allOk,
        'internal',
        RiskLevel.LOW,
        startTime,
        sessionId
      );
      return { ...res, toolResult: lastToolResult, plan };
    }

    // 2. Deterministic Natural-Language Tool Matching (reliable even offline)
    const directTool = this.matchDirectTool(trimmed, profile.timezone);
    if (directTool) {
      const toolRes = await registry.execute(directTool.tool, directTool.args, {
        actor: 'user',
        approvedHighRisk,
        timezone: profile.timezone,
      });
      const output = toolRes.success
        ? personality.formatVerifiedSuccess(toolRes.message, toolRes.verified)
        : personality.formatFailure(toolRes.error || toolRes.message);

      const res = await this.finish(
        intentId,
        trimmed,
        output,
        toolRes.success,
        'internal',
        RiskLevel.LOW,
        startTime,
        sessionId
      );
      return { ...res, toolResult: toolRes };
    }

    // 3. Explicit legacy intents (WhatsApp, Email, Browser/App control, Memory store/recall)
    const parser = getIntentParser();
    const parsedIntent = await parser.parse(trimmed);
    const legacyHandled = new Set<ActionType>([
      ActionType.SEND_WHATSAPP,
      ActionType.OPEN_BROWSER,
      ActionType.BROWSER_NAVIGATE,
      ActionType.OPEN_APP,
      ActionType.CLOSE_APP,
      ActionType.PC_CONTROL,
      ActionType.TAKE_SCREENSHOT,
      ActionType.DRAFT_EMAIL,
      ActionType.SEND_EMAIL,
      ActionType.READ_EMAIL,
      ActionType.SUMMARIZE_THREAD,
      ActionType.TRANSLATE_MESSAGE,
      ActionType.MEMORY_STORE,
      ActionType.MEMORY_RECALL,
      ActionType.SET_PREFERENCE,
    ]);

    if (legacyHandled.has(parsedIntent.action) && parsedIntent.confidence >= 0.75) {
      const routed = await getTaskRouter().route(parsedIntent);
      store.logConversation('assistant', routed.output || routed.error || '', parsedIntent.action, sessionId);
      return routed;
    }

    // 4. Local Ollama Structured Tool Calling & Reasoning
    const ollama = getOllamaClient();
    const ollamaStatus = await ollama.checkStatus(1_200);
    if (ollamaStatus.reachable && ollamaStatus.modelAvailable) {
      const memContext = store.getRelevantContext(trimmed, 6);
      const systemPrompt = personality.buildSystemPrompt(profile, memContext);
      const history = store.getRecentConversations(6, sessionId);

      const messages: OllamaChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history.slice(0, -1).map((h) => ({
          role: (h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: h.content,
        })),
        { role: 'user', content: trimmed },
      ];

      const chatRes = await ollama.chat({
        messages,
        tools: registry.toOllamaSchemas(),
      });

      if (chatRes.ok) {
        if (chatRes.toolCalls.length > 0) {
          const toolMessages: OllamaChatMessage[] = [...messages];
          let lastToolResult: ToolExecutionResult | undefined;

          for (const call of chatRes.toolCalls) {
            const execRes = await registry.execute(call.name, call.arguments, {
              actor: 'ollama-agent',
              approvedHighRisk,
              timezone: profile.timezone,
            });
            lastToolResult = execRes;
            toolMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({
                verified: execRes.verified,
                message: execRes.message,
                data: execRes.data,
                error: execRes.error,
              }),
            });
          }

          const finalChat = await ollama.chat({ messages: toolMessages });
          const finalText = finalChat.ok && finalChat.content
            ? finalChat.content
            : lastToolResult?.message || 'Done.';

          const result = await this.finish(
            intentId,
            trimmed,
            finalText,
            lastToolResult ? lastToolResult.success : true,
            'claw',
            RiskLevel.LOW,
            startTime,
            sessionId
          );
          return { ...result, toolResult: lastToolResult };
        }

        if (chatRes.content) {
          return this.finish(
            intentId,
            trimmed,
            chatRes.content,
            true,
            'claw',
            RiskLevel.LOW,
            startTime,
            sessionId
          );
        }
      } else {
        log.warn('Ollama chat call failed', { error: chatRes.error });
      }
    }

    // 5. Fallback to TaskRouter (ClawBridge) or honest offline guidance
    if (!ollamaStatus.reachable) {
      const honestMsg = personality.formatFailure(
        `Local Ollama server is not reachable at ${ollamaStatus.baseUrl}.`,
        `Start Ollama with "ollama serve" and ensure model "${ollamaStatus.configuredModel}" is pulled ("ollama pull ${ollamaStatus.configuredModel}").`
      );
      return this.finish(intentId, trimmed, honestMsg, false, 'internal', RiskLevel.LOW, startTime, sessionId);
    }

    const routed = await getTaskRouter().route(parsedIntent);
    store.logConversation('assistant', routed.output || routed.error || '', parsedIntent.action, sessionId);
    return routed;
  }

  /**
   * Deterministic NLU mapping for core assistant tools (monitoring, reminders, status, time).
   */
  private matchDirectTool(
    text: string,
    timezone: string
  ): { tool: string; args: Record<string, unknown> } | null {
    const lower = text.toLowerCase();

    // Time / Date
    if (/\b(what\s*(time|day|date)|current\s*(time|date)|time\s*right\s*now)\b/i.test(lower)) {
      return { tool: 'get_current_time', args: { timezone } };
    }

    // System / Ollama status
    if (/\b(check\s+ollama|ollama\s+status)\b/i.test(lower)) {
      return { tool: 'check_ollama_status', args: {} };
    }
    if (/\b(system\s*status|status\s*check|health\s*check|are\s+you\s+(online|working))\b/i.test(lower)) {
      return { tool: 'get_system_status', args: {} };
    }

    // Dashboard / Server monitoring commands
    if (/\b(pause)\b.*\b(monitor|monitoring|watch|watcher|dashboard)\b/i.test(lower)) {
      return { tool: 'pause_dashboard_watch', args: {} };
    }
    if (/\b(resume)\b.*\b(monitor|monitoring|watch|watcher|dashboard)\b/i.test(lower)) {
      return { tool: 'resume_dashboard_watch', args: {} };
    }
    if (/\b(stop)\b.*\b(monitor|monitoring|watch|watching|watcher|dashboard)\b/i.test(lower)) {
      return { tool: 'stop_dashboard_watch', args: {} };
    }
    if (/\b(what\s+are\s+you\s+monitoring|list\s+watchers|active\s+watchers|monitoring\s+status)\b/i.test(lower)) {
      return { tool: 'list_dashboard_watchers', args: {} };
    }
    if (/\b(yesterday'?s?\s+alerts|monitoring\s+history|recent\s+alerts|show\s+alerts)\b/i.test(lower)) {
      const since = new Date(Date.now() - 48 * 60 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
      return { tool: 'get_monitoring_history', args: { sinceIso: since, limit: 25 } };
    }
    if (/\b(watch|monitor|check)\b.*\b(dashboard|server|website|endpoint|erp|payment)\b/i.test(lower)) {
      const urlMatch = text.match(/https?:\/\/\S+/i);
      const everyMinMatch = lower.match(/every\s+(\d+)\s*(minute|min|second|sec)/i);
      let intervalMs = 60_000;
      if (everyMinMatch) {
        const num = parseInt(everyMinMatch[1], 10);
        intervalMs = everyMinMatch[2].startsWith('sec') ? num * 1_000 : num * 60_000;
      }
      const nameMatch = text.match(/\b(?:watch|monitor|check)\s+(?:my\s+)?([a-z0-9 _-]+?)(?:\s+every|\s+at|$)/i);
      const name = nameMatch?.[1]?.trim() || 'Default Dashboard';
      return {
        tool: 'start_dashboard_watch',
        args: {
          name,
          targetUrl: urlMatch?.[0] || '',
          intervalMs,
        },
      };
    }

    // Location-triggered reminder: "remind me to X when I reach college"
    const locReminder = text.match(/remind\s+me\s+(?:to\s+)?(.+?)\s+when\s+(?:i|we)\s+(?:reach|arrive\s+at|get\s+to)\s+(.+)/i);
    if (locReminder) {
      return {
        tool: 'create_reminder',
        args: {
          title: locReminder[1].trim(),
          locationName: locReminder[2].replace(/[.!?]+$/, '').trim(),
          triggerOn: 'enter',
        },
      };
    }

    // Alarm: "wake me up at 6 AM tomorrow"
    const alarmMatch = text.match(/wake\s+me\s+up\s+(?:at\s+)?(.+)/i);
    if (alarmMatch) {
      const due = this.parseNaturalTime(alarmMatch[1]);
      if (due) {
        return {
          tool: 'create_alarm',
          args: { title: 'Wake up alarm', dueAt: due.toISOString() },
        };
      }
    }

    // Recurring reminder: "remind me every Monday to check my projects"
    const recurringMatch = text.match(/remind\s+me\s+every\s+(day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:to\s+)?(.+)/i);
    if (recurringMatch) {
      const cadence = recurringMatch[1].toLowerCase() === 'day' ? 'daily' : 'weekly';
      const nextDate = this.parseNextWeekdayOrDaily(recurringMatch[1].toLowerCase());
      return {
        tool: 'create_reminder',
        args: {
          title: recurringMatch[2].replace(/[.!?]+$/, '').trim(),
          dueAt: nextDate.toISOString(),
          recurrence: cadence,
        },
      };
    }

    // One-time reminder: "remind me to submit my assignment at 5 PM"
    const reminderMatch = text.match(/remind\s+me\s+(?:to\s+)?(.+?)\s+(?:at|on|in)\s+(.+)/i);
    if (reminderMatch) {
      const due = this.parseNaturalTime(reminderMatch[2]);
      if (due) {
        return {
          tool: 'create_reminder',
          args: {
            title: reminderMatch[1].trim(),
            dueAt: due.toISOString(),
            recurrence: 'none',
          },
        };
      }
    }

    if (/\b(list|show|what\s+are\s+my)\b.*\b(reminders|alarms)\b/i.test(lower)) {
      return { tool: 'list_reminders', args: {} };
    }

    return null;
  }

  private parseNaturalTime(expr: string): Date | null {
    const clean = expr.replace(/[.!?]+$/, '').trim();
    const now = new Date();

    const inMin = clean.match(/(\d+)\s*(minute|min|hour|hr)s?/i);
    if (inMin) {
      const val = parseInt(inMin[1], 10);
      const ms = inMin[2].toLowerCase().startsWith('h') ? val * 3_600_000 : val * 60_000;
      return new Date(now.getTime() + ms);
    }

    const timeMatch = clean.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const meridiem = timeMatch[3]?.toLowerCase();
      if (meridiem === 'pm' && hours < 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;

      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);
      if (/\btomorrow\b/i.test(clean) || target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1);
      }
      return target;
    }

    const parsed = new Date(clean);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private parseNextWeekdayOrDaily(dayWord: string): Date {
    const now = new Date();
    if (dayWord === 'day') {
      return new Date(now.getTime() + 24 * 3_600_000);
    }
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const targetIdx = days.indexOf(dayWord);
    const diff = ((targetIdx - now.getDay() + 7) % 7) || 7;
    const target = new Date(now);
    target.setDate(now.getDate() + diff);
    target.setHours(9, 0, 0, 0);
    return target;
  }

  private async finish(
    intentId: string,
    input: string,
    output: string,
    success: boolean,
    executor: TaskResult['executor'],
    risk: RiskLevel,
    startTime: number,
    sessionId?: string
  ): Promise<TaskResult> {
    const durationMs = Date.now() - startTime;
    const store = await getMemoryStore();
    store.logConversation('assistant', output, undefined, sessionId);
    store.logTask(intentId, 'assistant', input, output, success, risk, executor, durationMs);
    return {
      id: uuidv4(),
      intentId,
      success,
      output,
      executor,
      durationMs,
      risk,
      approved: true,
      timestamp: new Date().toISOString(),
    };
  }
}

let _brain: AssistantBrain | null = null;
export function getAssistantBrain(): AssistantBrain {
  if (!_brain) {
    _brain = new AssistantBrain();
  }
  return _brain;
}
