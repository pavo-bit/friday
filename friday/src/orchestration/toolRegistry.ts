// ============================================================
// FRIDAY — Central Typed Capability Registry & Execution Lifecycle
// Schema-validated, permission-checked, audited capability execution
// ============================================================

import { RiskLevel } from '../shared/types';
import { getMemoryStore } from '../memory/store';
import { getConfig } from '../shared/config';
import { AIToolSchema } from '../ai/providers/AIProvider';
import { getOpenRouterProvider } from '../ai/providers/OpenRouterProvider';
import { getMonitoringEngine, MonitorMethod } from '../services/monitoringEngine';
import { getSchedulerService, RecurrenceType } from '../services/schedulerService';
import { getLocationService } from '../services/locationService';
import { getNotificationService, NotificationSeverity } from '../services/notificationService';
import { getClawBridge } from './clawBridge';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('CapabilityRegistry');

export type CapabilityCategory =
  | 'system'
  | 'monitoring'
  | 'scheduler'
  | 'location'
  | 'notifications'
  | 'finance'
  | 'trading'
  | 'files'
  | 'developer'
  | 'web'
  | 'research'
  | 'companion'
  | 'general';

export type CapabilityRiskLevel = 'low' | 'medium' | 'high';

export interface CapabilitySchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: CapabilitySchemaProperty;
}

export interface CapabilitySchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, CapabilitySchemaProperty>;
  required?: readonly string[];
  items?: CapabilitySchemaProperty;
  additionalProperties?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface AvailabilityResult {
  available: boolean;
  reason?: string;
}

export interface CapabilityProvenance {
  source: string;
  timestamp: string;
  freshness?: string;
}

export interface CapabilityContext {
  actor: string;
  taskId?: string;
  approvedHighRisk?: boolean;
  grantedPermissions?: readonly string[];
  timezone?: string;
}

export interface CapabilityResult {
  success: boolean;
  verified: boolean;
  capabilityId: string;
  tool: string;
  taskId?: string;
  data?: unknown;
  message: string;
  error?: string;
  provenance?: CapabilityProvenance;
  requiresApproval?: boolean;
  durationMs: number;
}

export interface CapabilityRawOutcome {
  verified: boolean;
  data?: unknown;
  message: string;
  provenance?: CapabilityProvenance;
}

export interface CapabilityDefinition {
  id: string;
  name: string;
  description: string;
  category: CapabilityCategory;
  version: string;
  inputSchema: CapabilitySchema;
  outputSchema: CapabilitySchema;
  permissions: string[];
  /** Legacy alias for permissions */
  requiredPermissions: string[];
  riskLevel: CapabilityRiskLevel;
  /** Legacy alias for riskLevel */
  risk: RiskLevel;
  timeoutMs: number;
  enabled: boolean;
  trusted: boolean;
  validate: (input: unknown) => ValidationResult;
  isAvailable: () => Promise<AvailabilityResult>;
  execute: (args: Record<string, unknown>, ctx: CapabilityContext) => Promise<CapabilityRawOutcome>;
}

/**
 * Legacy-compatible input shape for registering tools/capabilities.
 */
export interface RegisterCapabilityInput {
  id?: string;
  name: string;
  description: string;
  category?: CapabilityCategory;
  version?: string;
  inputSchema: CapabilitySchema | Record<string, unknown>;
  outputSchema: CapabilitySchema | Record<string, unknown>;
  permissions?: string[];
  requiredPermissions?: string[];
  riskLevel?: CapabilityRiskLevel;
  risk?: RiskLevel;
  timeoutMs?: number;
  enabled?: boolean;
  trusted?: boolean;
  validate?: (args: Record<string, unknown>) => string | null | ValidationResult;
  isAvailable?: () => Promise<AvailabilityResult>;
  execute: (args: Record<string, unknown>, ctx: CapabilityContext) => Promise<CapabilityRawOutcome>;
}

export interface CapabilityDiscoveryQuery {
  query?: string;
  category?: CapabilityCategory;
  includeDisabled?: boolean;
  maxRiskLevel?: CapabilityRiskLevel;
  onlyAvailable?: boolean;
}

// Backward-compatible type aliases
export type ToolContext = CapabilityContext;
export type ToolExecutionResult = CapabilityResult;
export type ToolDefinition = CapabilityDefinition;

const RISK_ORDER: Record<CapabilityRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function toRiskEnum(level: CapabilityRiskLevel): RiskLevel {
  if (level === 'high') return RiskLevel.HIGH;
  if (level === 'medium') return RiskLevel.MEDIUM;
  return RiskLevel.LOW;
}

function fromRiskEnum(risk: RiskLevel): CapabilityRiskLevel {
  if (risk === RiskLevel.HIGH) return 'high';
  if (risk === RiskLevel.MEDIUM) return 'medium';
  return 'low';
}

/**
 * Deterministic JSON-Schema-subset validator (zero external dependencies).
 */
export function validateAgainstSchema(value: unknown, schema: CapabilitySchema): ValidationResult {
  const errors: string[] = [];

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { valid: false, errors: ['Expected an object.'] };
    }
    const obj = value as Record<string, unknown>;

    if (schema.required) {
      for (const reqKey of schema.required) {
        if (obj[reqKey] === undefined || obj[reqKey] === null || obj[reqKey] === '') {
          errors.push(`Missing required field "${reqKey}".`);
        }
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const val = obj[key];
        if (val === undefined || val === null) continue;
        const propErr = validateProperty(key, val, propSchema);
        if (propErr) errors.push(propErr);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return { valid: false, errors: ['Expected an array.'] };
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemErr = validateProperty(`[${i}]`, value[i], schema.items);
        if (itemErr) errors.push(itemErr);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (actualType !== schema.type) {
    errors.push(`Expected ${schema.type}, received ${actualType}.`);
  }
  return { valid: errors.length === 0, errors };
}

function validateProperty(
  key: string,
  val: unknown,
  prop: CapabilitySchemaProperty
): string | null {
  if (prop.type === 'array') {
    if (!Array.isArray(val)) return `Field "${key}" must be an array.`;
    if (prop.items) {
      for (let i = 0; i < val.length; i++) {
        const err = validateProperty(`${key}[${i}]`, val[i], prop.items);
        if (err) return err;
      }
    }
    return null;
  }

  if (prop.type === 'object') {
    if (!val || typeof val !== 'object' || Array.isArray(val)) {
      return `Field "${key}" must be an object.`;
    }
    return null;
  }

  if (typeof val !== prop.type) {
    return `Field "${key}" must be of type ${prop.type}.`;
  }

  if (prop.type === 'number' && Number.isNaN(val as number)) {
    return `Field "${key}" must be a valid number.`;
  }

  if (prop.enum && typeof val === 'string' && !prop.enum.includes(val)) {
    return `Field "${key}" must be one of: ${prop.enum.join(', ')}.`;
  }

  return null;
}

export class CapabilityRegistry {
  private byId: Map<string, CapabilityDefinition> = new Map();
  private idByName: Map<string, string> = new Map();

  constructor() {
    this.registerBuiltInTools();
  }

  /**
   * Register a capability safely. Prevents duplicate IDs or names.
   * Untrusted capabilities are forced to HIGH risk so they cannot bypass SafetyGate.
   */
  register(input: RegisterCapabilityInput): CapabilityDefinition {
    const name = input.name?.trim();
    if (!name) {
      throw new Error('Capability name is required.');
    }

    const id = (input.id || `custom.${name}`).trim();
    if (!id) {
      throw new Error('Capability id is required.');
    }

    if (this.byId.has(id)) {
      throw new Error(`Duplicate capability id "${id}" is already registered.`);
    }
    if (this.idByName.has(name)) {
      throw new Error(`Duplicate capability name "${name}" is already registered.`);
    }

    const trusted = input.trusted ?? false;
    const declaredRisk: CapabilityRiskLevel =
      input.riskLevel ?? (input.risk ? fromRiskEnum(input.risk) : 'medium');

    // Security invariant: untrusted registrations can never self-declare low/medium risk
    const enforcedRisk: CapabilityRiskLevel = trusted ? declaredRisk : 'high';
    const permissions = [...(input.permissions ?? input.requiredPermissions ?? [])];
    const inputSchema = input.inputSchema as CapabilitySchema;
    const outputSchema = input.outputSchema as CapabilitySchema;
    const customValidate = input.validate;

    const capability: CapabilityDefinition = {
      id,
      name,
      description: input.description,
      category: input.category ?? 'general',
      version: input.version ?? '1.0.0',
      inputSchema,
      outputSchema,
      permissions,
      requiredPermissions: permissions,
      riskLevel: enforcedRisk,
      risk: toRiskEnum(enforcedRisk),
      timeoutMs: Math.max(500, input.timeoutMs ?? 5_000),
      enabled: input.enabled ?? true,
      trusted,
      validate: (rawInput: unknown): ValidationResult => {
        const schemaCheck = validateAgainstSchema(rawInput ?? {}, inputSchema);
        if (!schemaCheck.valid) return schemaCheck;

        if (customValidate) {
          const customRes = customValidate((rawInput ?? {}) as Record<string, unknown>);
          if (typeof customRes === 'string') {
            return { valid: false, errors: [customRes] };
          }
          if (customRes && typeof customRes === 'object' && 'valid' in customRes) {
            return customRes;
          }
        }
        return { valid: true, errors: [] };
      },
      isAvailable: input.isAvailable ?? (async () => ({ available: true })),
      execute: input.execute,
    };

    this.byId.set(id, capability);
    this.idByName.set(name, id);
    return capability;
  }

  /**
   * Unregister a capability by ID or name.
   */
  unregister(idOrName: string): boolean {
    const cap = this.get(idOrName);
    if (!cap) return false;
    this.byId.delete(cap.id);
    this.idByName.delete(cap.name);
    return true;
  }

  /**
   * Look up a capability by stable ID or legacy tool name.
   */
  get(idOrName: string): CapabilityDefinition | undefined {
    if (this.byId.has(idOrName)) return this.byId.get(idOrName);
    const mappedId = this.idByName.get(idOrName);
    return mappedId ? this.byId.get(mappedId) : undefined;
  }

  getById(id: string): CapabilityDefinition | undefined {
    return this.byId.get(id);
  }

  enable(idOrName: string): boolean {
    const cap = this.get(idOrName);
    if (!cap) return false;
    cap.enabled = true;
    return true;
  }

  disable(idOrName: string): boolean {
    const cap = this.get(idOrName);
    if (!cap) return false;
    cap.enabled = false;
    return true;
  }

  list(): CapabilityDefinition[] {
    return Array.from(this.byId.values());
  }

  listEnabled(): CapabilityDefinition[] {
    return this.list().filter((c) => c.enabled);
  }

  /**
   * Discover capabilities by query text, category, risk ceiling, and availability.
   */
  async discover(filter: CapabilityDiscoveryQuery = {}): Promise<CapabilityDefinition[]> {
    const queryLower = filter.query?.trim().toLowerCase();
    const keywords = queryLower ? queryLower.split(/\s+/).filter((w) => w.length > 1) : [];

    const candidates = this.list().filter((cap) => {
      if (!filter.includeDisabled && !cap.enabled) return false;
      if (filter.category && cap.category !== filter.category) return false;
      if (filter.maxRiskLevel && RISK_ORDER[cap.riskLevel] > RISK_ORDER[filter.maxRiskLevel]) {
        return false;
      }
      if (keywords.length > 0) {
        const haystack = `${cap.id} ${cap.name} ${cap.description} ${cap.category}`.toLowerCase();
        const matches = keywords.some((kw) => haystack.includes(kw));
        if (!matches) return false;
      }
      return true;
    });

    if (!filter.onlyAvailable) {
      return candidates;
    }

    const availableList: CapabilityDefinition[] = [];
    for (const cap of candidates) {
      try {
        const avail = await cap.isAvailable();
        if (avail.available) availableList.push(cap);
      } catch {
        // Unavailable if probe throws
      }
    }
    return availableList;
  }

  toToolSchemas(): AIToolSchema[] {
    return this.listEnabled().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as unknown as Record<string, unknown>,
      },
    }));
  }

  /**
   * Full execution lifecycle:
   * Lookup -> Enabled check -> Availability check -> Input schema validation ->
   * Permission & Risk check -> Bounded Timeout Execution ->
   * Output schema validation -> Audit Log.
   */
  async execute(
    idOrName: string,
    args: Record<string, unknown>,
    ctx: CapabilityContext = { actor: 'user' }
  ): Promise<CapabilityResult> {
    const started = Date.now();
    const cap = this.get(idOrName);
    const store = await getMemoryStore();

    if (!cap) {
      return {
        capabilityId: idOrName,
        tool: idOrName,
        taskId: ctx.taskId,
        success: false,
        verified: false,
        message: `Unknown capability "${idOrName}".`,
        error: `Capability "${idOrName}" is not registered.`,
        durationMs: Date.now() - started,
      };
    }

    if (!cap.enabled) {
      store.logAudit(ctx.actor, `capability:${cap.id}`, JSON.stringify(args), cap.risk, false, 'Capability disabled');
      return {
        capabilityId: cap.id,
        tool: cap.name,
        taskId: ctx.taskId,
        success: false,
        verified: false,
        message: `Capability "${cap.name}" is currently disabled.`,
        error: 'Capability disabled',
        durationMs: Date.now() - started,
      };
    }

    const validation = cap.validate(args ?? {});
    if (!validation.valid) {
      const errText = validation.errors.join(' ');
      store.logAudit(ctx.actor, `capability:${cap.id}`, JSON.stringify(args), cap.risk, false, errText);
      return {
        capabilityId: cap.id,
        tool: cap.name,
        taskId: ctx.taskId,
        success: false,
        verified: false,
        message: `Invalid arguments for ${cap.name}: ${errText}`,
        error: errText,
        durationMs: Date.now() - started,
      };
    }

    // Enforce grantedPermissions when caller/planner provides scoped permissions
    if (ctx.grantedPermissions) {
      const missing = cap.permissions.filter((p) => !ctx.grantedPermissions!.includes(p));
      if (missing.length > 0) {
        const msg = `Permission denied for "${cap.name}". Missing: ${missing.join(', ')}`;
        store.logAudit(ctx.actor, `capability:${cap.id}`, JSON.stringify(args), cap.risk, false, msg);
        return {
          capabilityId: cap.id,
          tool: cap.name,
          taskId: ctx.taskId,
          success: false,
          verified: false,
          message: msg,
          error: msg,
          durationMs: Date.now() - started,
        };
      }
    }

    const config = getConfig();
    if (cap.risk === RiskLevel.HIGH && config.requireHighRiskApproval && !ctx.approvedHighRisk) {
      store.logAudit(
        ctx.actor,
        `capability:${cap.id}`,
        JSON.stringify(args),
        cap.risk,
        false,
        'Requires explicit approval'
      );
      return {
        capabilityId: cap.id,
        tool: cap.name,
        taskId: ctx.taskId,
        success: false,
        verified: false,
        requiresApproval: true,
        message: `Capability "${cap.name}" is classified as high-risk and requires explicit user approval before execution.`,
        durationMs: Date.now() - started,
      };
    }

    try {
      const availability = await cap.isAvailable();
      if (!availability.available) {
        const reason = availability.reason || `Capability "${cap.name}" is currently unavailable.`;
        store.logAudit(ctx.actor, `capability:${cap.id}`, JSON.stringify(args), cap.risk, false, reason);
        return {
          capabilityId: cap.id,
          tool: cap.name,
          taskId: ctx.taskId,
          success: false,
          verified: false,
          message: reason,
          error: reason,
          durationMs: Date.now() - started,
        };
      }

      const execPromise = cap.execute(args ?? {}, ctx);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Capability "${cap.name}" timed out after ${cap.timeoutMs}ms`)), cap.timeoutMs)
      );

      const outcome = await Promise.race([execPromise, timeoutPromise]);
      const durationMs = Date.now() - started;

      // Validate output schema when data is returned and outcome claims verified
      if (outcome.verified && outcome.data !== undefined) {
        const outValidation = validateAgainstSchema(outcome.data, cap.outputSchema);
        if (!outValidation.valid) {
          const outErr = `Output schema validation failed: ${outValidation.errors.join(' ')}`;
          store.logAudit(ctx.actor, `capability:${cap.id}`, JSON.stringify(args), cap.risk, false, outErr);
          return {
            capabilityId: cap.id,
            tool: cap.name,
            taskId: ctx.taskId,
            success: false,
            verified: false,
            message: `Execution output for "${cap.name}" failed schema verification.`,
            error: outErr,
            durationMs,
          };
        }
      }

      store.logAudit(ctx.actor, `capability:${cap.id}`, JSON.stringify(args), cap.risk, outcome.verified, outcome.message);

      return {
        capabilityId: cap.id,
        tool: cap.name,
        taskId: ctx.taskId,
        success: outcome.verified,
        verified: outcome.verified,
        data: outcome.data,
        message: outcome.message,
        provenance: outcome.provenance ?? {
          source: cap.id,
          timestamp: new Date().toISOString(),
        },
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - started;
      const errMsg = (err as Error).message || 'Capability execution failed';
      log.error(`Capability ${cap.id} failed`, { error: errMsg });
      store.logAudit(ctx.actor, `capability:${cap.id}`, JSON.stringify(args), cap.risk, false, errMsg);
      return {
        capabilityId: cap.id,
        tool: cap.name,
        taskId: ctx.taskId,
        success: false,
        verified: false,
        message: `Failed to execute ${cap.name}: ${errMsg}`,
        error: errMsg,
        durationMs,
      };
    }
  }

  private registerBuiltInTools(): void {
    this.register({
      id: 'core.time.get_current_time',
      name: 'get_current_time',
      description: 'Get the current date and time in the configured timezone.',
      category: 'system',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['read:time'],
      timeoutMs: 2_000,
      trusted: true,
      inputSchema: { type: 'object', properties: { timezone: { type: 'string' } } },
      outputSchema: {
        type: 'object',
        properties: { iso: { type: 'string' }, formatted: { type: 'string' }, timezone: { type: 'string' } },
        required: ['iso', 'formatted', 'timezone'],
      },
      execute: async (args, ctx) => {
        const store = await getMemoryStore();
        const tz =
          (typeof args.timezone === 'string' && args.timezone) ||
          ctx.timezone ||
          store.getPersonalityProfile().timezone ||
          'Asia/Kolkata';
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
      id: 'core.system.get_system_status',
      name: 'get_system_status',
      description: 'Get overall FRIDAY status including OpenRouter AI provider, Claw runtime, active watchers, and pending reminders.',
      category: 'system',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['read:status'],
      timeoutMs: 5_000,
      trusted: true,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', required: ['aiProvider', 'clawAvailable', 'activeWatchers', 'pendingReminders'] },
      execute: async () => {
        const store = await getMemoryStore();
        const aiProvider = await getOpenRouterProvider().checkStatus();
        const bridge = getClawBridge();
        const watchers = await getMonitoringEngine().listWatchers();
        const reminders = await getSchedulerService().listReminders('pending');
        const activeWatchers = watchers.filter((w) => w.status === 'active' && w.workerRunning);

        return {
          verified: true,
          data: {
            aiProvider,
            clawAvailable: bridge.isAvailable(),
            memory: store.getStats(),
            activeWatchers: activeWatchers.length,
            pendingReminders: reminders.length,
            uptimeSeconds: Math.floor(process.uptime()),
          },
          message: `OpenRouter: ${aiProvider.reachable ? 'online' : 'offline'} (${aiProvider.configuredModel || 'unconfigured'}); Claw runtime: ${
            bridge.isAvailable() ? 'online' : 'offline'
          }; Active watchers: ${activeWatchers.length}; Pending reminders: ${reminders.length}.`,
        };
      },
    });

    this.register({
      id: 'core.system.check_ai_provider_status',
      name: 'check_ai_provider_status',
      description: 'Check whether the OpenRouter AI provider is configured, reachable, and if the configured model is available.',
      category: 'system',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['read:status'],
      timeoutMs: 5_000,
      trusted: true,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', required: ['reachable', 'baseUrl', 'configuredModel'] },
      execute: async () => {
        const status = await getOpenRouterProvider().checkStatus();
        return {
          verified: true,
          data: status,
          message: status.reachable
            ? `OpenRouter is reachable at ${status.baseUrl}. Configured model "${status.configuredModel}" is ${
                status.modelAvailable ? 'available' : 'not listed'
              }.`
            : `OpenRouter is not reachable at ${status.baseUrl} (${status.error || 'unavailable'}).`,
        };
      },
    });

    this.register({
      id: 'core.monitoring.check_server_health',
      name: 'check_server_health',
      description: 'Probe a specific HTTP/HTTPS server or health endpoint once and return status and latency.',
      category: 'monitoring',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['network:probe'],
      timeoutMs: 10_000,
      trusted: true,
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      outputSchema: { type: 'object', required: ['url', 'ok'] },
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
      id: 'core.scheduler.create_reminder',
      name: 'create_reminder',
      description: 'Create a one-time, recurring, or location-triggered reminder.',
      category: 'scheduler',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['write:reminders'],
      timeoutMs: 5_000,
      trusted: true,
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
      outputSchema: { type: 'object', required: ['id', 'title', 'status'] },
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
      id: 'core.scheduler.create_alarm',
      name: 'create_alarm',
      description: 'Create an alarm at a specific date and time.',
      category: 'scheduler',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['write:reminders'],
      timeoutMs: 5_000,
      trusted: true,
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, dueAt: { type: 'string' } },
        required: ['title', 'dueAt'],
      },
      outputSchema: { type: 'object', required: ['id', 'title', 'isAlarm'] },
      validate: (args) => {
        if (typeof args.title !== 'string' || !args.title.trim()) return 'title is required';
        if (typeof args.dueAt !== 'string' || Number.isNaN(new Date(args.dueAt).getTime())) {
          return 'valid dueAt is required';
        }
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
      id: 'core.scheduler.list_reminders',
      name: 'list_reminders',
      description: 'List reminders and alarms, optionally filtered by status.',
      category: 'scheduler',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['read:reminders'],
      timeoutMs: 3_000,
      trusted: true,
      inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
      outputSchema: { type: 'array' },
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
      id: 'core.scheduler.update_reminder',
      name: 'update_reminder',
      description: 'Update an existing reminder title, time, or status.',
      category: 'scheduler',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['write:reminders'],
      timeoutMs: 3_000,
      trusted: true,
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
      outputSchema: { type: 'object', required: ['id', 'title'] },
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
      id: 'core.scheduler.delete_reminder',
      name: 'delete_reminder',
      description: 'Delete a reminder by ID.',
      category: 'scheduler',
      version: '1.0.0',
      riskLevel: 'medium',
      permissions: ['write:reminders'],
      timeoutMs: 3_000,
      trusted: true,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object', required: ['deleted'] },
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
      id: 'core.monitoring.start_dashboard_watch',
      name: 'start_dashboard_watch',
      description: 'Create and start a persistent monitoring watcher for a dashboard, URL, API, or service.',
      category: 'monitoring',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['write:watchers'],
      timeoutMs: 12_000,
      trusted: true,
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
      outputSchema: { type: 'object', required: ['id', 'name', 'status', 'workerRunning'] },
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
      id: 'core.monitoring.stop_dashboard_watch',
      name: 'stop_dashboard_watch',
      description: 'Stop an active dashboard or service watcher.',
      category: 'monitoring',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['write:watchers'],
      timeoutMs: 5_000,
      trusted: true,
      inputSchema: { type: 'object', properties: { idOrName: { type: 'string' } } },
      outputSchema: { type: 'object', required: ['id'] },
      execute: async (args) => {
        const monitoring = getMonitoringEngine();
        const target =
          typeof args.idOrName === 'string' && args.idOrName
            ? await monitoring.getWatcher(args.idOrName)
            : await monitoring.getDefaultWatcher();
        if (!target) return { verified: false, message: 'No matching watcher found to stop.' };
        const ok = await monitoring.stopWatcher(target.id);
        return { verified: ok, data: { id: target.id }, message: `Stopped monitoring "${target.name}".` };
      },
    });

    this.register({
      id: 'core.monitoring.pause_dashboard_watch',
      name: 'pause_dashboard_watch',
      description: 'Pause an active dashboard or service watcher.',
      category: 'monitoring',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['write:watchers'],
      timeoutMs: 5_000,
      trusted: true,
      inputSchema: { type: 'object', properties: { idOrName: { type: 'string' } } },
      outputSchema: { type: 'object', required: ['id'] },
      execute: async (args) => {
        const monitoring = getMonitoringEngine();
        const target =
          typeof args.idOrName === 'string' && args.idOrName
            ? await monitoring.getWatcher(args.idOrName)
            : await monitoring.getDefaultWatcher();
        if (!target) return { verified: false, message: 'No matching watcher found to pause.' };
        const ok = await monitoring.pauseWatcher(target.id);
        return { verified: ok, data: { id: target.id }, message: `Paused monitoring "${target.name}".` };
      },
    });

    this.register({
      id: 'core.monitoring.resume_dashboard_watch',
      name: 'resume_dashboard_watch',
      description: 'Resume a paused dashboard or service watcher.',
      category: 'monitoring',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['write:watchers'],
      timeoutMs: 10_000,
      trusted: true,
      inputSchema: { type: 'object', properties: { idOrName: { type: 'string' } } },
      outputSchema: { type: 'object', required: ['id', 'workerRunning'] },
      execute: async (args) => {
        const monitoring = getMonitoringEngine();
        const target =
          typeof args.idOrName === 'string' && args.idOrName
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
      id: 'core.monitoring.get_dashboard_watch_status',
      name: 'get_dashboard_watch_status',
      description: 'Get the current health and worker status of a specific dashboard watcher.',
      category: 'monitoring',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['read:watchers'],
      timeoutMs: 3_000,
      trusted: true,
      inputSchema: { type: 'object', properties: { idOrName: { type: 'string' } } },
      outputSchema: { type: 'object' },
      execute: async (args) => {
        const monitoring = getMonitoringEngine();
        const target =
          typeof args.idOrName === 'string' && args.idOrName
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
      id: 'core.monitoring.list_dashboard_watchers',
      name: 'list_dashboard_watchers',
      description: 'List all configured dashboard and service watchers.',
      category: 'monitoring',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['read:watchers'],
      timeoutMs: 3_000,
      trusted: true,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'array' },
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
      id: 'core.monitoring.get_monitoring_history',
      name: 'get_monitoring_history',
      description: 'Retrieve recent monitoring checks and alerts (for example yesterday or today alerts).',
      category: 'monitoring',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['read:watchers'],
      timeoutMs: 3_000,
      trusted: true,
      inputSchema: {
        type: 'object',
        properties: { watcherId: { type: 'string' }, sinceIso: { type: 'string' }, limit: { type: 'number' } },
      },
      outputSchema: { type: 'array' },
      execute: async (args) => {
        const history = await getMonitoringEngine().getHistory(
          typeof args.watcherId === 'string' ? args.watcherId : undefined,
          typeof args.sinceIso === 'string' ? args.sinceIso : undefined,
          typeof args.limit === 'number' ? args.limit : 25
        );
        return {
          verified: true,
          data: history,
          message:
            history.length === 0
              ? 'No monitoring check history found for that period.'
              : `Retrieved ${history.length} monitoring check record(s).`,
        };
      },
    });

    this.register({
      id: 'core.location.get_location_status',
      name: 'get_location_status',
      description: 'List saved geofence locations and location-based reminder status.',
      category: 'location',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['read:locations'],
      timeoutMs: 3_000,
      trusted: true,
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'array' },
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
      id: 'core.notifications.send_notification',
      name: 'send_notification',
      description: 'Create and broadcast a FRIDAY notification to the dashboard and paired devices.',
      category: 'notifications',
      version: '1.0.0',
      riskLevel: 'low',
      permissions: ['write:notifications'],
      timeoutMs: 3_000,
      trusted: true,
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

    // Register Financial Intelligence capabilities (Phase 6)
    const { registerFinanceCapabilities } = require('../finance/financeCapabilities');
    registerFinanceCapabilities(this);

    // Register Trading Copilot capabilities (Phase 7)
    const { registerTradingCapabilities } = require('../trading/tradingCapabilities');
    registerTradingCapabilities(this);

    // Register Web Research capabilities (Phase 14)
    const { registerResearchCapabilities } = require('../research/researchCapabilities');
    registerResearchCapabilities(this);
  }
}

// Backward-compatible class & singleton aliases
export const ToolRegistry = CapabilityRegistry;
export type ToolRegistry = CapabilityRegistry;

let _registry: CapabilityRegistry | null = null;
export function getCapabilityRegistry(): CapabilityRegistry {
  if (!_registry) {
    _registry = new CapabilityRegistry();
  }
  return _registry;
}

export function getToolRegistry(): CapabilityRegistry {
  return getCapabilityRegistry();
}
