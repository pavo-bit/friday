// ============================================================
// FRIDAY — JARVIS Display Manager
// Converts verified task results into safe PresentationContracts
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { redactSecrets } from '../memory/redaction';
import { eventBus } from '../shared/events';
import { WsMessageType } from '../shared/types';
import { BackgroundTaskRecord, TaskStepRecord } from '../orchestration/backgroundOrchestrator';
import { TaskVerificationResult } from '../orchestration/resultVerifier';
import { getSafetyGate } from '../orchestration/safetyGate';
import {
  PresentationAction,
  PresentationContract,
  PresentationType,
  validatePresentationContract,
} from './presentationTypes';

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeUnknown);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = sanitizeUnknown(v);
      }
    }
    return out;
  }
  return value;
}

function mapPresentationRow(row: Record<string, unknown>): PresentationContract {
  return {
    presentationId: String(row.presentation_id),
    taskId: row.task_id ? String(row.task_id) : null,
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    ownerId: String(row.owner_id),
    presentationType: String(row.presentation_type) as PresentationType,
    title: String(row.title),
    summary: String(row.summary),
    data: JSON.parse(String(row.data_json || '{}')) as Record<string, unknown>,
    verificationStatus: String(row.verification_status) as PresentationContract['verificationStatus'],
    provenance: JSON.parse(String(row.provenance_json || '[]')),
    actions: JSON.parse(String(row.actions_json || '[]')),
    createdAt: String(row.created_at),
  };
}

export class DisplayManager {
  selectPresentationType(
    verification: TaskVerificationResult,
    steps: TaskStepRecord[]
  ): PresentationType {
    if (verification.status === 'WAITING_FOR_APPROVAL') {
      return 'approval';
    }
    if (verification.status === 'FAILED' || verification.status === 'UNAVAILABLE' || verification.status === 'UNVERIFIED') {
      return 'error';
    }

    const completedWithData = steps.filter(
      (s) => s.status === 'COMPLETED' && s.result?.data && typeof s.result.data === 'object'
    );

    if (completedWithData.length === 1) {
      const d = completedWithData[0].result!.data as Record<string, unknown>;
      if (Array.isArray(d.rows) || (Array.isArray(d.items) && d.items.length > 0 && typeof d.items[0] === 'object')) {
        return 'table';
      }
      if (Array.isArray(d.series) || (Array.isArray(d.labels) && Array.isArray(d.values))) {
        return 'chart';
      }
      if (Array.isArray(d.metrics)) {
        return 'metric';
      }
      const scalarNums = Object.entries(d).filter(
        ([k, v]) => typeof v === 'number' && k !== 'freshnessSeconds' && k !== 'maxAgeSeconds'
      );
      if (scalarNums.length >= 2 && scalarNums.length <= 6) {
        return 'metric';
      }
    }

    if (steps.length > 1 || verification.partial) {
      return 'report';
    }

    return 'summary';
  }

  private buildStructuredData(
    presentationType: PresentationType,
    task: BackgroundTaskRecord,
    steps: TaskStepRecord[],
    verification: TaskVerificationResult
  ): Record<string, unknown> {
    const completed = steps.filter((s) => s.status === 'COMPLETED');
    const firstData =
      completed[0]?.result?.data && typeof completed[0].result.data === 'object'
        ? (completed[0].result.data as Record<string, unknown>)
        : {};

    const stepTrace = steps.map((s, idx) => ({
      stepId: s.stepId,
      capabilityId: s.capabilityId,
      status: s.status,
      order: s.executionOrder ?? idx,
      durationMs: s.durationMs,
      verificationStatus:
        verification.stepVerifications.find((v) => v.stepId === s.stepId)?.status || 'UNVERIFIED',
      message: redactSecrets(s.result?.message || s.errorMessage || ''),
    }));

    if (presentationType === 'table') {
      const rows = (Array.isArray(firstData.rows) ? firstData.rows : firstData.items) as Array<
        Record<string, unknown>
      >;
      const columns =
        Array.isArray(firstData.columns) && firstData.columns.length > 0
          ? firstData.columns
          : rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null
            ? Object.keys(rows[0])
            : [];
      return sanitizeUnknown({ columns, rows, steps: stepTrace }) as Record<string, unknown>;
    }

    if (presentationType === 'chart') {
      return sanitizeUnknown({
        chartType: typeof firstData.chartType === 'string' ? firstData.chartType : 'bar',
        labels: Array.isArray(firstData.labels) ? firstData.labels : [],
        values: Array.isArray(firstData.values) ? firstData.values : [],
        series: Array.isArray(firstData.series) ? firstData.series : [],
        steps: stepTrace,
      }) as Record<string, unknown>;
    }

    if (presentationType === 'metric') {
      const metrics = Array.isArray(firstData.metrics)
        ? firstData.metrics
        : Object.entries(firstData)
            .filter(([k, v]) => typeof v === 'number' && k !== 'freshnessSeconds' && k !== 'maxAgeSeconds')
            .map(([label, value]) => ({ label, value }));
      return sanitizeUnknown({ metrics, steps: stepTrace }) as Record<string, unknown>;
    }

    if (presentationType === 'report') {
      const sections = steps.map((s) => ({
        stepId: s.stepId,
        capabilityId: s.capabilityId,
        status: s.status,
        summary: s.result?.message || s.errorMessage || s.status,
        data: s.result?.data || null,
      }));
      return sanitizeUnknown({
        partial: verification.partial,
        completedSteps: verification.completedSteps,
        failedSteps: verification.failedSteps,
        totalSteps: verification.totalSteps,
        sections,
        steps: stepTrace,
      }) as Record<string, unknown>;
    }

    if (presentationType === 'error') {
      return sanitizeUnknown({
        errorCode: task.errorCode || 'VERIFICATION_FAILED',
        errorMessage: task.errorMessage || verification.errors[0] || verification.summary,
        errors: verification.errors,
        partial: verification.partial,
        steps: stepTrace,
      }) as Record<string, unknown>;
    }

    return sanitizeUnknown({
      output: completed.map((s) => s.result?.message).filter(Boolean).join('\n') || verification.summary,
      details: firstData,
      steps: stepTrace,
    }) as Record<string, unknown>;
  }

  async presentTaskResult(
    task: BackgroundTaskRecord,
    steps: TaskStepRecord[],
    verification: TaskVerificationResult
  ): Promise<PresentationContract> {
    const presentationId = uuidv4();
    const presentationType = this.selectPresentationType(verification, steps);
    const createdAt = new Date().toISOString();

    const title = redactSecrets(
      task.originalRequest.length > 80
        ? `${task.originalRequest.slice(0, 77)}...`
        : task.originalRequest || `Task ${task.id.slice(0, 8)}`
    );

    const summary = redactSecrets(
      verification.status === 'VERIFIED'
        ? steps
            .filter((s) => s.status === 'COMPLETED' && s.result?.message)
            .map((s) => s.result!.message)
            .join(' · ') || verification.summary
        : verification.summary
    );

    const data = this.buildStructuredData(presentationType, task, steps, verification);

    const actions: PresentationAction[] = [];
    if (presentationType === 'approval') {
      const pendingApprovals = await getSafetyGate().listBoundApprovals({
        actorId: task.ownerId,
        taskId: task.id,
        status: 'PENDING',
      });
      for (const app of pendingApprovals) {
        actions.push(
          {
            actionId: `approve:${app.approvalId}`,
            label: 'Approve',
            kind: 'approve',
            approvalId: app.approvalId,
            taskId: task.id,
          },
          {
            actionId: `reject:${app.approvalId}`,
            label: 'Reject',
            kind: 'reject',
            approvalId: app.approvalId,
            taskId: task.id,
          }
        );
      }
    }

    const contract: PresentationContract = {
      presentationId,
      taskId: task.id,
      conversationId: task.conversationId || null,
      ownerId: task.ownerId || 'local',
      presentationType,
      title,
      summary,
      data,
      verificationStatus: verification.status,
      provenance: verification.provenance,
      actions,
      createdAt,
    };

    const validation = validatePresentationContract(contract);
    if (!validation.valid) {
      const errMsg = `Presentation validation failed: ${validation.errors.join('; ')}`;
      eventBus.emitEvent('presentation.failed', {
        taskId: task.id,
        ownerId: contract.ownerId,
        error: errMsg,
        timestamp: new Date().toISOString(),
      });
      eventBus.emitEvent('ws:broadcast', {
        type: WsMessageType.PRESENTATION_EVENT,
        payload: {
          eventType: 'presentation.failed',
          ownerId: contract.ownerId,
          taskId: task.id,
          error: errMsg,
        },
        timestamp: new Date().toISOString(),
      });
      throw new Error(errMsg);
    }

    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (db) {
      db.prepare(
        `INSERT INTO presentations (
          presentation_id, task_id, conversation_id, owner_id,
          presentation_type, title, summary, data_json,
          verification_status, provenance_json, actions_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        contract.presentationId,
        contract.taskId,
        contract.conversationId,
        contract.ownerId,
        contract.presentationType,
        contract.title,
        contract.summary,
        JSON.stringify(contract.data),
        contract.verificationStatus,
        JSON.stringify(contract.provenance),
        JSON.stringify(contract.actions),
        contract.createdAt
      );
    }

    const eventPayload = {
      eventType: 'presentation.ready',
      ownerId: contract.ownerId,
      presentation: contract,
    };

    eventBus.emitEvent('presentation.created', {
      ownerId: contract.ownerId,
      presentationId: contract.presentationId,
      taskId: contract.taskId,
    });
    eventBus.emitEvent('presentation.ready', eventPayload);
    eventBus.emitEvent('ws:broadcast', {
      type: WsMessageType.PRESENTATION_EVENT,
      payload: eventPayload,
      timestamp: contract.createdAt,
    });

    return contract;
  }

  async getPresentation(presentationId: string, ownerId: string): Promise<{
    found: boolean;
    forbidden?: boolean;
    presentation?: PresentationContract;
  }> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return { found: false };

    const row = db
      .prepare(`SELECT * FROM presentations WHERE presentation_id = ? LIMIT 1`)
      .get(presentationId) as Record<string, unknown> | undefined;

    if (!row) return { found: false };
    const mapped = mapPresentationRow(row);
    if (mapped.ownerId !== ownerId) {
      return { found: true, forbidden: true };
    }
    return { found: true, presentation: mapped };
  }

  async getTaskPresentation(taskId: string, ownerId: string): Promise<{
    found: boolean;
    forbidden?: boolean;
    presentation?: PresentationContract;
  }> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return { found: false };

    const row = db
      .prepare(`SELECT * FROM presentations WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(taskId) as Record<string, unknown> | undefined;

    if (!row) return { found: false };
    const mapped = mapPresentationRow(row);
    if (mapped.ownerId !== ownerId) {
      return { found: true, forbidden: true };
    }
    return { found: true, presentation: mapped };
  }

  async listPresentations(
    ownerId: string,
    options?: { conversationId?: string; limit?: number }
  ): Promise<PresentationContract[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];

    const limit = Math.min(Math.max(options?.limit ?? 30, 1), 100);
    const rows = options?.conversationId
      ? (db
          .prepare(
            `SELECT * FROM presentations WHERE owner_id = ? AND conversation_id = ? ORDER BY created_at DESC LIMIT ?`
          )
          .all(ownerId, options.conversationId, limit) as Array<Record<string, unknown>>)
      : (db
          .prepare(`SELECT * FROM presentations WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?`)
          .all(ownerId, limit) as Array<Record<string, unknown>>);

    return rows.map(mapPresentationRow);
  }

  async buildFollowUpContext(
    ownerId: string,
    conversationId: string,
    limit = 3
  ): Promise<Array<{ presentationId: string; title: string; summary: string; verificationStatus: string }>> {
    const list = await this.listPresentations(ownerId, { conversationId, limit });
    return list.map((p) => ({
      presentationId: p.presentationId,
      title: p.title,
      summary: p.summary,
      verificationStatus: p.verificationStatus,
    }));
  }
}

let _displayManager: DisplayManager | null = null;
export function getDisplayManager(): DisplayManager {
  if (!_displayManager) {
    _displayManager = new DisplayManager();
  }
  return _displayManager;
}
