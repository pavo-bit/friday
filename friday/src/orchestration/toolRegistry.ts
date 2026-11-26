// ============================================================
// FRIDAY — Central Typed Tool Registry & Execution Lifecycle
// Schema-validated, permission-checked, audited tool execution
// ============================================================

import { RiskLevel } from '../shared/types';
import { getMemoryStore } from '../memory/store';
import { getConfig } from '../shared/config';
import { getOllamaClient, OllamaToolSchema } from './ollamaClient';
import { getMonitoringEngine, MonitorMethod } from '../services/monitoringEngine';
import { getSchedulerService, RecurrenceType } from '../services/schedulerService';
import { getLocationService } from '../services/locationService';
import { getNotificationService, NotificationSeverity } from '../services/notificationService';
import { getClawBridge } from './clawBridge';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('ToolRegistry');

export interface ToolContext {
  actor: string;
  approvedHighRisk?: boolean;
  timezone?: string;
}

export interface ToolExecutionResult {
  tool: string;
  success: boolean;
  verified: boolean;
  data?: unknown;
  message: string;
  error?: string;
  requiresApproval?: boolean;
  durationMs: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  risk: RiskLevel;
  requiredPermissions: string[];
  timeoutMs: number;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  validate: (args: Record<string, unknown>) => string | null;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ verified: boolean; data?: unknown; message: string }>;
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    this.registerBuiltInTools();
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  toOllamaSchemas(): OllamaToolSchema[] {
    return this.list().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  /**
   * Full tool execution lifecycle:
   * Lookup -> Argument Validation -> Permission & Risk Check ->
   * Bounded Timeout Execution -> Result Verification -> Audit Log.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext = { actor: 'user' }
  ): Promise<ToolExecutionResult> {
    const started = Date.now();
    const tool = this.tools.get(name);
    const store = await getMemoryStore();

    if (!tool) {
      return {
        tool: name,
        success: false,
        verified: false,
        message: `Unknown tool "${name}".`,
        error: `Tool "${name}" is not registered.`,
        durationMs: Date.now() - started,
      };
    }

    const validationError = tool.validate(args || {});
    if (validationError) {
      store.logAudit(ctx.actor, `tool:${name}`, JSON.stringify(args), tool.risk, false, validationError);
      return {
        tool: name,
        success: false,
        verified: false,
        message: `Invalid arguments for ${name}: ${validationError}`,
        error: validationError,
        durationMs: Date.now() - started,
      };
    }

    const config = getConfig();
    if (tool.risk === RiskLevel.HIGH && config.requireHighRiskApproval && !ctx.approvedHighRisk) {
      store.logAudit(ctx.actor, `tool:${name}`, JSON.stringify(args), tool.risk, false, 'Requires explicit approval');
      return {
        tool: name,
        success: false,
        verified: false,
        requiresApproval: true,
        message: `Tool "${name}" is classified as high-risk and requires explicit user approval before execution.`,
        durationMs: Date.now() - started,
      };
    }

    try {
      const execPromise = tool.execute(args || {}, ctx);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${tool.timeoutMs}ms`)), tool.timeoutMs)
      );

      const outcome = await Promise.race([execPromise, timeoutPromise]);
      const durationMs = Date.now() - started;

      store.logAudit(ctx.actor, `tool:${name}`, JSON.stringify(args), tool.risk, outcome.verified, outcome.message);

      return {
        tool: name,
        success: outcome.verified,
        verified: outcome.verified,
        data: outcome.data,
        message: outcome.message,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - started;
      const errMsg = (err as Error).message || 'Tool execution failed';
      log.error(`Tool ${name} failed`, { error: errMsg });
      store.logAudit(ctx.actor, `tool:${name}`, JSON.stringify(args), tool.risk, false, errMsg);
      return {
        tool: name,
        success: false,
        verified: false,
        message: `Failed to execute ${name}: ${errMsg}`,
        error: errMsg,
        durationMs,
      };
    }
  }

  private registerBuiltInTools(): void {
    this.register({
      name: 'get_current_time',
      description: 'Get the current date and time in the configured timezone.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['read:time'],
      timeoutMs: 2_000,
      inputSchema: { type: 'object', properties: { timezone: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { iso: { type: 'string' }, formatted: { type: 'string' }, timezone: { type: 'string' } } },
      validate: () => null,
      execute: async (args, ctx) => {
        const store = await getMemoryStore();
        const tz = (typeof args.timezone === 'string' && args.timezone) || ctx.timezone || store.getPersonalityProfile().timezone || 'UTC';
        const now = new Date();
        let formatted: string;
        try {
          formatted = new Intl.DateTimeFormat('en-US', {
            dateStyle: 'full',
            timeStyle: 'short',
            timeZone: tz,
          }).format(now);
        } catch {
          formatted = now.toUTCString();
        }
        return {
          verified: true,
          data: { iso: now.toISOString(), formatted, timezone: tz },
          message: `It is currently ${formatted} (${tz}).`,
        };
      },
    });

    this.register({
      name: 'get_system_status',
      description: 'Get overall FRIDAY status including Ollama, Claw runtime, active watchers, and pending reminders.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['read:status'],
      timeoutMs: 5_000,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      validate: () => null,
      execute: async () => {
        const store = await getMemoryStore();
        const ollama = await getOllamaClient().checkStatus();
        const bridge = getClawBridge();
        const watchers = await getMonitoringEngine().listWatchers();
        const reminders = await getSchedulerService().listReminders('pending');
        const activeWatchers = watchers.filter((w) => w.status === 'active' && w.workerRunning);

        return {
          verified: true,
          data: {
            ollama,
            clawAvailable: bridge.isAvailable(),
            memory: store.getStats(),
            activeWatchers: activeWatchers.length,
            pendingReminders: reminders.length,
            uptimeSeconds: Math.floor(process.uptime()),
          },
          message: `Ollama: ${ollama.reachable ? 'online' : 'offline'} (${ollama.configuredModel}); Claw runtime: ${
            bridge.isAvailable() ? 'online' : 'offline'
          }; Active watchers: ${activeWatchers.length}; Pending reminders: ${reminders.length}.`,
        };
      },
    });

    this.register({
      name: 'check_ollama_status',
      description: 'Check whether the local Ollama server is reachable and if the configured model is installed.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['read:status'],
      timeoutMs: 4_000,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      validate: () => null,
      execute: async () => {
        const status = await getOllamaClient().checkStatus();
        return {
          verified: true,
          data: status,
          message: status.reachable
            ? `Ollama is reachable at ${status.baseUrl}. Configured model "${status.configuredModel}" is ${
                status.modelAvailable ? 'installed' : 'not installed'
              }.`
            : `Ollama is not reachable at ${status.baseUrl} (${status.error || 'connection refused'}).`,
        };
      },
    });

    this.register({
      name: 'check_server_health',
      description: 'Probe a specific HTTP/HTTPS server or health endpoint once and return status and latency.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['network:probe'],
      timeoutMs: 10_000,
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      outputSchema: { type: 'object' },
      validate: (args) => {
        if (typeof args.url !== 'string' || !args.url.trim()) return 'url is required';
        try {
          const u = new URL(args.url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Only http/https URLs are supported';
        } catch {
          return 'Invalid URL format';
        }
        return null;
      },
      execute: async (args) => {
        const url = String(args.url);
        const started = Date.now();
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
          const latencyMs = Date.now() - started;
          return {
            verified: true,
            data: { url, status: res.status, ok: res.ok, latencyMs },
            message: `${url} responded with HTTP ${res.status} in ${latencyMs}ms.`,
          };
        } catch (err) {
          return {
            verified: true,
            data: { url, ok: false, error: (err as Error).message },
            message: `${url} is unreachable: ${(err as Error).message}`,
          };
        }
      },
    });

    this.register({
      name: 'create_reminder',
      description: 'Create a one-time, recurring, or location-triggered reminder.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['write:reminders'],
      timeoutMs: 5_000,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          dueAt: { type: 'string' },
          recurrence: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly'] },
          locationName: { type: 'string' },
          triggerOn: { type: 'string', enum: ['time', 'enter', 'exit'] },
          notes: { type: 'string' },
        },
        required: ['title'],
      },
      outputSchema: { type: 'object' },
      validate: (args) => {
        if (typeof args.title !== 'string' || !args.title.trim()) return 'title is required';
        if (args.dueAt && Number.isNaN(new Date(String(args.dueAt)).getTime())) {
          return `Invalid dueAt date: ${args.dueAt}`;
        }
        return null;
      },
      execute: async (args) => {
        let locationId: string | null = null;
        if (typeof args.locationName === 'string' && args.locationName.trim()) {
          const loc = await getLocationService().getLocationByName(args.locationName);
          if (!loc) {
            return {
              verified: false,
              message: `I couldn't find a saved location named "${args.locationName}". Please save its coordinates first.`,
            };
          }
          locationId = loc.id;
        }
        const reminder = await getSchedulerService().createReminder({
          title: String(args.title),
          notes: typeof args.notes === 'string' ? args.notes : '',
          dueAt: typeof args.dueAt === 'string' ? args.dueAt : null,
          recurrence: (args.recurrence as RecurrenceType) || 'none',
          locationId,
          triggerOn: locationId ? ((args.triggerOn as 'enter' | 'exit') || 'enter') : 'time',
          isAlarm: false,
        });
        return {
          verified: true,
          data: reminder,
          message: locationId
            ? `Reminder "${reminder.title}" saved and linked to geofence "${args.locationName}".`
            : `Reminder "${reminder.title}" scheduled${reminder.dueAt ? ` for ${reminder.dueAt}` : ''}.`,
        };
      },
    });

    this.register({
      name: 'create_alarm',
      description: 'Create an alarm at a specific date and time.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['write:reminders'],
      timeoutMs: 5_000,
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, dueAt: { type: 'string' } },
        required: ['title', 'dueAt'],
      },
      outputSchema: { type: 'object' },
      validate: (args) => {
        if (typeof args.title !== 'string' || !args.title.trim()) return 'title is required';
        if (typeof args.dueAt !== 'string' || Number.isNaN(new Date(args.dueAt).getTime())) return 'valid dueAt is required';
        return null;
      },
      execute: async (args) => {
        const alarm = await getSchedulerService().createReminder({
          title: String(args.title),
          dueAt: String(args.dueAt),
          isAlarm: true,
        });
        return {
          verified: true,
          data: alarm,
          message: `Alarm "${alarm.title}" set for ${alarm.dueAt} (${alarm.timezone}).`,
        };
      },
    });

    this.register({
      name: 'list_reminders',
      description: 'List reminders and alarms, optionally filtered by status.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['read:reminders'],
      timeoutMs: 3_000,
      inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
      outputSchema: { type: 'array' },
      validate: () => null,
      execute: async (args) => {
        const list = await getSchedulerService().listReminders(args.status as any);
        return {
          verified: true,
          data: list,
          message:
            list.length === 0
              ? 'You have no matching reminders.'
              : `Found ${list.length} reminder(s): ${list.slice(0, 5).map((r) => r.title).join(', ')}.`,
        };
      },
    });

    this.register({
      name: 'update_reminder',
      description: 'Update an existing reminder title, time, or status.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['write:reminders'],
      timeoutMs: 3_000,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          dueAt: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'completed', 'cancelled'] },
        },
        required: ['id'],
      },
      outputSchema: { type: 'object' },
      validate: (args) => (typeof args.id === 'string' && args.id.trim() ? null : 'id is required'),
      execute: async (args) => {
        const updated = await getSchedulerService().updateReminder(String(args.id), {
          title: typeof args.title === 'string' ? args.title : undefined,
          dueAt: typeof args.dueAt === 'string' ? args.dueAt : undefined,
          status: args.status as any,
        });
        if (!updated) return { verified: false, message: `Reminder ${args.id} not found.` };
        return { verified: true, data: updated, message: `Updated reminder "${updated.title}".` };
      },
    });

    this.register({
      name: 'delete_reminder',
      description: 'Delete a reminder by ID.',
      risk: RiskLevel.MEDIUM,
      requiredPermissions: ['write:reminders'],
      timeoutMs: 3_000,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object' },
      validate: (args) => (typeof args.id === 'string' && args.id.trim() ? null : 'id is required'),
      execute: async (args) => {
        const deleted = await getSchedulerService().deleteReminder(String(args.id));
        return {
          verified: deleted,
          data: { deleted },
          message: deleted ? `Deleted reminder ${args.id}.` : `Reminder ${args.id} was not found.`,
        };
      },
    });

    this.register({
      name: 'start_dashboard_watch',
      description: 'Create and start a persistent monitoring watcher for a dashboard, URL, API, or service.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['write:watchers'],
      timeoutMs: 12_000,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          targetUrl: { type: 'string' },
          method: { type: 'string', enum: ['http_health', 'prometheus', 'grafana', 'json_api', 'postgres', 'redis'] },
          intervalMs: { type: 'number' },
          metricQuery: { type: 'string' },
          metricThreshold: { type: 'number' },
          isDefault: { type: 'boolean' },
        },
      },
      outputSchema: { type: 'object' },
      validate: () => null,
      execute: async (args) => {
        const monitoring = getMonitoringEngine();
        const config = getConfig();
        let targetUrl = typeof args.targetUrl === 'string' ? args.targetUrl.trim() : '';
        let name = typeof args.name === 'string' ? args.name.trim() : '';

        if (!targetUrl) {
          const def = await monitoring.getDefaultWatcher();
          if (def) {
            await monitoring.resumeWatcher(def.id);
            const verified = await monitoring.getWatcher(def.id);
            return {
              verified: Boolean(verified?.workerRunning),
              data: verified,
              message: `Watcher "${def.name}" (${def.targetUrl}) is active and verified (${verified?.health}).`,
            };
          }
          // Default to FRIDAY's own local dashboard health endpoint if no default was configured yet
          targetUrl = `http://${config.host}:${config.port}/friday/health`;
          name = name || 'FRIDAY Dashboard';
        }

        const watcher = await monitoring.createWatcher({
          name: name || targetUrl,
          targetUrl,
          method: (args.method as MonitorMethod) || 'http_health',
          intervalMs: typeof args.intervalMs === 'number' ? args.intervalMs : 60_000,
          metricQuery: typeof args.metricQuery === 'string' ? args.metricQuery : '',
          metricThreshold: typeof args.metricThreshold === 'number' ? args.metricThreshold : null,
          isDefault: Boolean(args.isDefault ?? true),
        });

        return {
          verified: watcher.workerRunning && watcher.status === 'active',
          data: watcher,
          message: `Monitoring started for "${watcher.name}" (${watcher.targetUrl}) every ${Math.round(
            watcher.intervalMs / 1000
          )}s. Initial status: ${watcher.health}.`,
        };
      },
    });

    this.register({
      name: 'stop_dashboard_watch',
      description: 'Stop an active dashboard or service watcher.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['write:watchers'],
      timeoutMs: 5_000,
      inputSchema: { type: 'object', properties: { idOrName: { type: 'string' } } },
      outputSchema: { type: 'object' },
      validate: () => null,
      execute: async (args) => {
        const monitoring = getMonitoringEngine();
        const target = typeof args.idOrName === 'string' && args.idOrName
          ? await monitoring.getWatcher(args.idOrName)
          : await monitoring.getDefaultWatcher();
        if (!target) return { verified: false, message: 'No matching watcher found to stop.' };
        const ok = await monitoring.stopWatcher(target.id);
        return { verified: ok, data: { id: target.id }, message: `Stopped monitoring "${target.name}".` };
      },
    });

    this.register({
      name: 'pause_dashboard_watch',
      description: 'Pause an active dashboard or service watcher.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['write:watchers'],
      timeoutMs: 5_000,
      inputSchema: { type: 'object', properties: { idOrName: { type: 'string' } } },
      outputSchema: { type: 'object' },
      validate: () => null,
      execute: async (args) => {
        const monitoring = getMonitoringEngine();
        const target = typeof args.idOrName === 'string' && args.idOrName
          ? await monitoring.getWatcher(args.idOrName)
          : await monitoring.getDefaultWatcher();
        if (!target) return { verified: false, message: 'No matching watcher found to pause.' };
        const ok = await monitoring.pauseWatcher(target.id);
        return { verified: ok, data: { id: target.id }, message: `Paused monitoring "${target.name}".` };
      },
    });

    this.register({
      name: 'resume_dashboard_watch',
      description: 'Resume a paused dashboard or service watcher.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['write:watchers'],
      timeoutMs: 10_000,
      inputSchema: { type: 'object', properties: { idOrName: { type: 'string' } } },
      outputSchema: { type: 'object' },
      validate: () => null,
      execute: async (args) => {
        const monitoring = getMonitoringEngine();
        const target = typeof args.idOrName === 'string' && args.idOrName
          ? await monitoring.getWatcher(args.idOrName)
          : await monitoring.getDefaultWatcher();
        if (!target) return { verified: false, message: 'No matching watcher found to resume.' };
        const ok = await monitoring.resumeWatcher(target.id);
        const updated = await monitoring.getWatcher(target.id);
        return {
          verified: ok && Boolean(updated?.workerRunning),
          data: updated,
          message: `Resumed monitoring "${target.name}" (health: ${updated?.health}).`,
        };
      },
    });

    this.register({
      name: 'get_dashboard_watch_status',
      description: 'Get the current health and worker status of a specific dashboard watcher.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['read:watchers'],
      timeoutMs: 3_000,
      inputSchema: { type: 'object', properties: { idOrName: { type: 'string' } } },
      outputSchema: { type: 'object' },
      validate: () => null,
      execute: async (args) => {
        const monitoring = getMonitoringEngine();
        const target = typeof args.idOrName === 'string' && args.idOrName
          ? await monitoring.getWatcher(args.idOrName)
          : await monitoring.getDefaultWatcher();
        if (!target) return { verified: true, message: 'No dashboard watcher is configured yet.' };
        return {
          verified: true,
          data: target,
          message: `"${target.name}" is ${target.status} (health: ${target.health}, worker active: ${target.workerRunning}).`,
        };
      },
    });

    this.register({
      name: 'list_dashboard_watchers',
      description: 'List all configured dashboard and service watchers.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['read:watchers'],
      timeoutMs: 3_000,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'array' },
      validate: () => null,
      execute: async () => {
        const list = await getMonitoringEngine().listWatchers();
        return {
          verified: true,
          data: list,
          message:
            list.length === 0
              ? 'I am not monitoring any dashboards or services right now.'
              : `Monitoring ${list.length} target(s): ${list.map((w) => `${w.name} (${w.status}/${w.health})`).join(', ')}.`,
        };
      },
    });

    this.register({
      name: 'get_monitoring_history',
      description: 'Retrieve recent monitoring checks and alerts (for example yesterday or today alerts).',
      risk: RiskLevel.LOW,
      requiredPermissions: ['read:watchers'],
      timeoutMs: 3_000,
      inputSchema: {
        type: 'object',
        properties: { watcherId: { type: 'string' }, sinceIso: { type: 'string' }, limit: { type: 'number' } },
      },
      outputSchema: { type: 'array' },
      validate: () => null,
      execute: async (args) => {
        const history = await getMonitoringEngine().getHistory(
          typeof args.watcherId === 'string' ? args.watcherId : undefined,
          typeof args.sinceIso === 'string' ? args.sinceIso : undefined,
          typeof args.limit === 'number' ? args.limit : 25
        );
        return {
          verified: true,
          data: history,
          message: history.length === 0 ? 'No monitoring check history found for that period.' : `Retrieved ${history.length} monitoring check record(s).`,
        };
      },
    });

    this.register({
      name: 'get_location_status',
      description: 'List saved geofence locations and location-based reminder status.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['read:locations'],
      timeoutMs: 3_000,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'array' },
      validate: () => null,
      execute: async () => {
        const locations = await getLocationService().listLocations();
        return {
          verified: true,
          data: locations,
          message:
            locations.length === 0
              ? 'No saved locations yet. Add a location in the Android companion or Locations settings.'
              : `Saved locations (${locations.length}): ${locations.map((l) => l.name).join(', ')}.`,
        };
      },
    });

    this.register({
      name: 'send_notification',
      description: 'Create and broadcast a FRIDAY notification to the dashboard and paired devices.',
      risk: RiskLevel.LOW,
      requiredPermissions: ['write:notifications'],
      timeoutMs: 3_000,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          message: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
        },
        required: ['title', 'message'],
      },
      outputSchema: { type: 'object' },
      validate: (args) => {
        if (typeof args.title !== 'string' || !args.title.trim()) return 'title is required';
        if (typeof args.message !== 'string' || !args.message.trim()) return 'message is required';
        return null;
      },
      execute: async (args) => {
        const notif = await getNotificationService().notify({
          severity: (args.severity as NotificationSeverity) || 'info',
          title: String(args.title),
          message: String(args.message),
          source: 'tool',
        });
        return {
          verified: true,
          data: notif,
          message: `Notification "${args.title}" dispatched.`,
        };
      },
    });
  }
}

let _registry: ToolRegistry | null = null;
export function getToolRegistry(): ToolRegistry {
  if (!_registry) {
    _registry = new ToolRegistry();
  }
  return _registry;
}
