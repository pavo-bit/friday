// ============================================================
// FRIDAY — Persistent Action-Bound Approval Store
// Deterministic canonical hashing + single-use SQLite approvals
// ============================================================

import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { redactSecrets } from '../memory/redaction';
import { createLayerLogger } from '../shared/logger';

const log = createLayerLogger('ApprovalStore');

export type BoundApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CONSUMED'
  | 'CANCELLED';

export interface ActionBindingInput {
  taskId: string;
  stepId: string;
  capabilityId: string;
  argumentsHash: string;
  actorId: string;
  deviceId: string;
  permissionScope: string;
}

export interface BoundApprovalRecord {
  approvalId: string;
  taskId: string | null;
  stepId: string | null;
  capabilityId: string;
  actionHash: string;
  argumentsHash: string;
  actorId: string;
  deviceId: string;
  permissionScope: string;
  riskLevel: string;
  status: BoundApprovalStatus;
  summary: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  consumedAt: string | null;
}

export interface CreateBoundApprovalInput {
  taskId: string;
  stepId: string;
  capabilityId: string;
  args: Record<string, unknown>;
  actorId: string;
  deviceId: string;
  permissionScope: string;
  riskLevel: string;
  summary?: string;
  ttlMs?: number;
}

export interface ResolveBoundApprovalResult {
  ok: boolean;
  status: BoundApprovalStatus;
  httpStatus: number;
  error?: string;
  approval?: BoundApprovalRecord;
}

export interface ConsumeBoundApprovalResult {
  ok: boolean;
  error?: string;
  approval?: BoundApprovalRecord;
}

/**
 * Deterministic canonical JSON serialization with sorted object keys.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => (item === undefined ? 'null' : canonicalizeJson(item)));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export function computeArgumentsHash(args: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalizeJson(args || {})).digest('hex');
}

export function computeActionHash(binding: ActionBindingInput): string {
  return crypto.createHash('sha256').update(canonicalizeJson(binding)).digest('hex');
}

function mapApprovalRow(row: Record<string, unknown>): BoundApprovalRecord {
  return {
    approvalId: String(row.approval_id),
    taskId: row.task_id ? String(row.task_id) : null,
    stepId: row.step_id ? String(row.step_id) : null,
    capabilityId: String(row.capability_id),
    actionHash: String(row.action_hash),
    argumentsHash: String(row.arguments_hash),
    actorId: String(row.actor_id),
    deviceId: String(row.device_id),
    permissionScope: String(row.permission_scope),
    riskLevel: String(row.risk_level),
    status: String(row.status) as BoundApprovalStatus,
    summary: row.summary ? String(row.summary) : null,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    resolution: row.resolution ? String(row.resolution) : null,
    resolvedBy: row.resolved_by ? String(row.resolved_by) : null,
    consumedAt: row.consumed_at ? String(row.consumed_at) : null,
  };
}

function isExpired(expiresAt: string): boolean {
  const ms = Date.parse(expiresAt);
  return !Number.isNaN(ms) && Date.now() > ms;
}

export class ApprovalStore {
  async create(input: CreateBoundApprovalInput): Promise<BoundApprovalRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable for approval creation');

    const approvalId = uuidv4();
    const argumentsHash = computeArgumentsHash(input.args || {});
    const actionHash = computeActionHash({
      taskId: input.taskId,
      stepId: input.stepId,
      capabilityId: input.capabilityId,
      argumentsHash,
      actorId: input.actorId,
      deviceId: input.deviceId,
      permissionScope: input.permissionScope,
    });

    const ttlMs = input.ttlMs ?? 15 * 60_000;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const safeSummary = input.summary ? redactSecrets(input.summary) : null;

    db.prepare(
      `INSERT INTO capability_approvals (
        approval_id, task_id, step_id, capability_id,
        action_hash, arguments_hash, actor_id, device_id,
        permission_scope, risk_level, status, summary,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
    ).run(
      approvalId,
      input.taskId,
      input.stepId,
      input.capabilityId,
      actionHash,
      argumentsHash,
      input.actorId,
      input.deviceId,
      input.permissionScope,
      input.riskLevel,
      safeSummary,
      createdAt,
      expiresAt
    );

    store.logAudit(
      input.actorId,
      'approval:create',
      `${input.capabilityId} task=${input.taskId} step=${input.stepId} id=${approvalId}`,
      input.riskLevel,
      true
    );

    const record = await this.getById(approvalId);
    if (!record) throw new Error('Failed to load created approval');
    return record;
  }

  async getById(approvalId: string): Promise<BoundApprovalRecord | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;

    const row = db
      .prepare(`SELECT * FROM capability_approvals WHERE approval_id = ? LIMIT 1`)
      .get(approvalId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const mapped = mapApprovalRow(row);
    if ((mapped.status === 'PENDING' || mapped.status === 'APPROVED') && isExpired(mapped.expiresAt)) {
      db.prepare(
        `UPDATE capability_approvals SET status = 'EXPIRED' WHERE approval_id = ? AND status IN ('PENDING', 'APPROVED')`
      ).run(approvalId);
      mapped.status = 'EXPIRED';
    }
    return mapped;
  }

  async list(filter?: {
    actorId?: string;
    taskId?: string;
    status?: BoundApprovalStatus;
    limit?: number;
  }): Promise<BoundApprovalRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    // Mark any overdue PENDING/APPROVED approvals as EXPIRED first
    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE capability_approvals SET status = 'EXPIRED'
       WHERE status IN ('PENDING', 'APPROVED') AND expires_at < ?`
    ).run(nowIso);

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.actorId) {
      clauses.push('actor_id = ?');
      params.push(filter.actorId);
    }
    if (filter?.taskId) {
      clauses.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    params.push(limit);

    const rows = db
      .prepare(`SELECT * FROM capability_approvals ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map(mapApprovalRow);
  }

  async resolve(params: {
    approvalId: string;
    decision: 'APPROVE' | 'REJECT' | 'CANCEL';
    actorId: string;
    resolution?: string;
  }): Promise<ResolveBoundApprovalResult> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) {
      return { ok: false, status: 'PENDING', httpStatus: 503, error: 'Database unavailable' };
    }

    const existing = await this.getById(params.approvalId);
    if (!existing) {
      return { ok: false, status: 'PENDING', httpStatus: 404, error: 'Approval not found' };
    }

    if (existing.actorId !== params.actorId) {
      store.logAudit(
        params.actorId,
        'approval:unauthorized_resolve',
        `approval=${params.approvalId} owner=${existing.actorId}`,
        existing.riskLevel,
        false
      );
      return {
        ok: false,
        status: existing.status,
        httpStatus: 403,
        error: 'Forbidden: approval belongs to another actor',
      };
    }

    if (existing.status === 'EXPIRED' || isExpired(existing.expiresAt)) {
      db.prepare(
        `UPDATE capability_approvals SET status = 'EXPIRED' WHERE approval_id = ? AND status IN ('PENDING', 'APPROVED')`
      ).run(params.approvalId);
      store.logAudit(params.actorId, 'approval:expired', params.approvalId, existing.riskLevel, false);
      const expired = await this.getById(params.approvalId);
      return {
        ok: false,
        status: 'EXPIRED',
        httpStatus: 410,
        error: 'Approval has expired',
        approval: expired || existing,
      };
    }

    if (existing.status !== 'PENDING') {
      return {
        ok: false,
        status: existing.status,
        httpStatus: 409,
        error: `Approval is already ${existing.status}`,
        approval: existing,
      };
    }

    const nextStatus: BoundApprovalStatus =
      params.decision === 'APPROVE'
        ? 'APPROVED'
        : params.decision === 'REJECT'
          ? 'REJECTED'
          : 'CANCELLED';

    const resolvedAt = new Date().toISOString();
    const safeResolution = params.resolution ? redactSecrets(params.resolution) : nextStatus.toLowerCase();

    const info = db
      .prepare(
        `UPDATE capability_approvals
         SET status = ?, resolved_at = ?, resolution = ?, resolved_by = ?
         WHERE approval_id = ? AND status = 'PENDING'`
      )
      .run(nextStatus, resolvedAt, safeResolution, params.actorId, params.approvalId);

    if (info.changes !== 1) {
      const current = await this.getById(params.approvalId);
      return {
        ok: false,
        status: current?.status || existing.status,
        httpStatus: 409,
        error: 'Approval state changed concurrently',
        approval: current || undefined,
      };
    }

    store.logAudit(
      params.actorId,
      `approval:${nextStatus.toLowerCase()}`,
      `approval=${params.approvalId} capability=${existing.capabilityId}`,
      existing.riskLevel,
      true
    );

    const updated = await this.getById(params.approvalId);
    return {
      ok: true,
      status: nextStatus,
      httpStatus: 200,
      approval: updated || existing,
    };
  }

  async consume(params: {
    approvalId: string;
    taskId: string;
    stepId: string;
    capabilityId: string;
    args: Record<string, unknown>;
    actorId: string;
    deviceId: string;
    permissionScope: string;
  }): Promise<ConsumeBoundApprovalResult> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) {
      return { ok: false, error: 'Database unavailable' };
    }

    const existing = await this.getById(params.approvalId);
    if (!existing) {
      return { ok: false, error: 'Approval not found' };
    }

    if (existing.status === 'EXPIRED' || isExpired(existing.expiresAt)) {
      db.prepare(
        `UPDATE capability_approvals SET status = 'EXPIRED' WHERE approval_id = ? AND status IN ('PENDING', 'APPROVED')`
      ).run(params.approvalId);
      store.logAudit(params.actorId, 'approval:consume_expired', params.approvalId, existing.riskLevel, false);
      return { ok: false, error: 'Approval has expired' };
    }

    if (existing.status !== 'APPROVED') {
      store.logAudit(
        params.actorId,
        'approval:consume_invalid_state',
        `approval=${params.approvalId} status=${existing.status}`,
        existing.riskLevel,
        false
      );
      return { ok: false, error: `Approval is ${existing.status}, expected APPROVED` };
    }

    const argumentsHash = computeArgumentsHash(params.args || {});
    const actionHash = computeActionHash({
      taskId: params.taskId,
      stepId: params.stepId,
      capabilityId: params.capabilityId,
      argumentsHash,
      actorId: params.actorId,
      deviceId: params.deviceId,
      permissionScope: params.permissionScope,
    });

    if (existing.argumentsHash !== argumentsHash || existing.actionHash !== actionHash) {
      log.warn('Approval binding mismatch', {
        approvalId: params.approvalId,
        capabilityId: params.capabilityId,
        taskId: params.taskId,
        stepId: params.stepId,
      });
      store.logAudit(
        params.actorId,
        'approval:binding_mismatch',
        `approval=${params.approvalId} capability=${params.capabilityId}`,
        'high',
        false
      );
      return {
        ok: false,
        error: 'Approval binding mismatch: action, arguments, actor, device, or scope does not match',
      };
    }

    const consumedAt = new Date().toISOString();
    const info = db
      .prepare(
        `UPDATE capability_approvals
         SET status = 'CONSUMED', consumed_at = ?
         WHERE approval_id = ?
           AND status = 'APPROVED'
           AND consumed_at IS NULL
           AND action_hash = ?
           AND arguments_hash = ?`
      )
      .run(consumedAt, params.approvalId, actionHash, argumentsHash);

    if (info.changes !== 1) {
      return { ok: false, error: 'Approval already consumed or concurrently modified' };
    }

    store.logAudit(
      params.actorId,
      'approval:consume',
      `approval=${params.approvalId} capability=${params.capabilityId} task=${params.taskId}`,
      existing.riskLevel,
      true
    );

    const updated = await this.getById(params.approvalId);
    return { ok: true, approval: updated || existing };
  }

  async cancelForTask(taskId: string): Promise<number> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return 0;

    const now = new Date().toISOString();
    const info = db
      .prepare(
        `UPDATE capability_approvals
         SET status = 'CANCELLED', resolved_at = COALESCE(resolved_at, ?), resolution = COALESCE(resolution, 'task_cancelled')
         WHERE task_id = ? AND status IN ('PENDING', 'APPROVED')`
      )
      .run(now, taskId);

    return info.changes;
  }
}

let _approvalStore: ApprovalStore | null = null;
export function getApprovalStore(): ApprovalStore {
  if (!_approvalStore) {
    _approvalStore = new ApprovalStore();
  }
  return _approvalStore;
}
