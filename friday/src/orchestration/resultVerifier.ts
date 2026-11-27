// ============================================================
// FRIDAY — Deterministic Result Verification Engine
// Validates structure, status, schema, provenance & freshness
// ============================================================

import { BackgroundTaskRecord, TaskStepRecord } from './backgroundOrchestrator';
import { CapabilityDefinition, CapabilityRegistry } from './toolRegistry';

export type VerificationStatus =
  | 'VERIFIED'
  | 'PARTIALLY_VERIFIED'
  | 'UNVERIFIED'
  | 'FAILED'
  | 'UNAVAILABLE'
  | 'STALE'
  | 'WAITING_FOR_APPROVAL';

export type DataSourceType =
  | 'live'
  | 'delayed'
  | 'cached'
  | 'user_entered'
  | 'fixture'
  | 'unknown';

export interface ProvenanceRecord {
  capabilityId: string;
  sourceName: string;
  sourceType: DataSourceType;
  timestamp: string;
  freshnessSeconds: number | null;
  freshnessLabel: string;
  stale: boolean;
}

export interface StepVerificationRecord {
  stepId: string;
  capabilityId: string;
  status: VerificationStatus;
  schemaValid: boolean;
  errors: string[];
  provenance: ProvenanceRecord;
  message: string;
}

export interface TaskVerificationResult {
  taskId: string;
  status: VerificationStatus;
  verifiedAt: string;
  summary: string;
  completedSteps: number;
  failedSteps: number;
  waitingSteps: number;
  totalSteps: number;
  partial: boolean;
  stepVerifications: StepVerificationRecord[];
  provenance: ProvenanceRecord[];
  errors: string[];
}

const VALID_SOURCE_TYPES = new Set<DataSourceType>([
  'live',
  'delayed',
  'cached',
  'user_entered',
  'fixture',
  'unknown',
]);

/**
 * Validate a plain object against a CapabilitySchema (required fields & primitive types).
 */
function validateOutputAgainstSchema(
  data: unknown,
  schema: CapabilityDefinition['outputSchema']
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!schema || typeof schema !== 'object') {
    return { valid: true, errors };
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties || {};

  if (required.length > 0 && (!data || typeof data !== 'object' || Array.isArray(data))) {
    return { valid: false, errors: ['Output data must be an object matching outputSchema'] };
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    for (const reqKey of required) {
      if (obj[reqKey] === undefined || obj[reqKey] === null) {
        errors.push(`Missing required output field "${reqKey}"`);
      }
    }
    for (const [key, propDef] of Object.entries(props)) {
      const val = obj[key];
      if (val === undefined || val === null) continue;
      if (propDef.type === 'string' && typeof val !== 'string') {
        errors.push(`Output field "${key}" expected string, got ${typeof val}`);
      } else if (propDef.type === 'number' && (typeof val !== 'number' || Number.isNaN(val))) {
        errors.push(`Output field "${key}" expected number, got ${typeof val}`);
      } else if (propDef.type === 'boolean' && typeof val !== 'boolean') {
        errors.push(`Output field "${key}" expected boolean, got ${typeof val}`);
      } else if (propDef.type === 'array' && !Array.isArray(val)) {
        errors.push(`Output field "${key}" expected array, got ${typeof val}`);
      } else if (propDef.type === 'object' && (typeof val !== 'object' || Array.isArray(val))) {
        errors.push(`Output field "${key}" expected object, got ${typeof val}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function extractProvenance(
  step: TaskStepRecord,
  cap: CapabilityDefinition | undefined
): ProvenanceRecord {
  const rawData =
    step.result?.data && typeof step.result.data === 'object' && !Array.isArray(step.result.data)
      ? (step.result.data as Record<string, unknown>)
      : {};

  const provObj =
    rawData.provenance && typeof rawData.provenance === 'object' && !Array.isArray(rawData.provenance)
      ? (rawData.provenance as Record<string, unknown>)
      : rawData;

  const sourceName =
    typeof provObj.sourceName === 'string' && provObj.sourceName.trim()
      ? provObj.sourceName.trim()
      : typeof provObj.source === 'string' && provObj.source.trim()
        ? provObj.source.trim()
        : cap?.name || step.capabilityId;

  const rawType = typeof provObj.sourceType === 'string' ? provObj.sourceType.trim() : 'unknown';
  const sourceType: DataSourceType = VALID_SOURCE_TYPES.has(rawType as DataSourceType)
    ? (rawType as DataSourceType)
    : 'unknown';

  const timestamp =
    typeof provObj.timestamp === 'string' && !Number.isNaN(Date.parse(provObj.timestamp))
      ? provObj.timestamp
      : step.completedAt || new Date().toISOString();

  let freshnessSeconds: number | null = null;
  if (typeof provObj.freshnessSeconds === 'number' && Number.isFinite(provObj.freshnessSeconds)) {
    freshnessSeconds = Math.max(0, provObj.freshnessSeconds);
  } else if (typeof provObj.timestamp === 'string' && !Number.isNaN(Date.parse(provObj.timestamp))) {
    freshnessSeconds = Math.max(0, Math.round((Date.now() - Date.parse(provObj.timestamp)) / 1000));
  }

  const maxAgeSeconds =
    typeof provObj.maxAgeSeconds === 'number' && Number.isFinite(provObj.maxAgeSeconds)
      ? provObj.maxAgeSeconds
      : null;

  const explicitStale = provObj.stale === true;
  const ageStale =
    freshnessSeconds !== null && maxAgeSeconds !== null && freshnessSeconds > maxAgeSeconds;
  const stale = explicitStale || ageStale || sourceType === 'cached';

  let freshnessLabel = 'Freshness metadata unavailable';
  if (stale) {
    freshnessLabel =
      sourceType === 'cached'
        ? `Cached data${freshnessSeconds !== null ? ` (${freshnessSeconds}s old)` : ''}`
        : `Stale data${freshnessSeconds !== null ? ` (${freshnessSeconds}s old)` : ''}`;
  } else if (freshnessSeconds !== null) {
    freshnessLabel = `${sourceType} (${freshnessSeconds}s old)`;
  } else if (sourceType !== 'unknown') {
    freshnessLabel = `${sourceType} (freshness age unavailable)`;
  }

  return {
    capabilityId: step.capabilityId,
    sourceName,
    sourceType,
    timestamp,
    freshnessSeconds,
    freshnessLabel,
    stale,
  };
}

export class ResultVerifier {
  verifyStepResult(
    task: BackgroundTaskRecord,
    step: TaskStepRecord,
    cap: CapabilityDefinition | undefined
  ): StepVerificationRecord {
    const provenance = extractProvenance(step, cap);
    const errors: string[] = [];

    if (step.taskId !== task.id) {
      errors.push(`Step taskId mismatch: expected ${task.id}, got ${step.taskId}`);
      return {
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        status: 'UNVERIFIED',
        schemaValid: false,
        errors,
        provenance,
        message: errors[0],
      };
    }

    if (!cap) {
      errors.push(`Capability "${step.capabilityId}" is not registered or unavailable`);
      return {
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        status: 'UNAVAILABLE',
        schemaValid: false,
        errors,
        provenance,
        message: errors[0],
      };
    }

    if (step.status === 'WAITING_FOR_APPROVAL') {
      return {
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        status: 'WAITING_FOR_APPROVAL',
        schemaValid: true,
        errors: [],
        provenance,
        message: step.errorMessage || 'Waiting for user approval.',
      };
    }

    if (
      step.status === 'FAILED' ||
      step.status === 'TIMED_OUT' ||
      step.status === 'CANCELLED' ||
      step.status === 'INTERRUPTED' ||
      step.status === 'SKIPPED'
    ) {
      const msg = step.errorMessage || `Step ended with status ${step.status}`;
      errors.push(msg);
      return {
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        status: 'FAILED',
        schemaValid: false,
        errors,
        provenance,
        message: msg,
      };
    }

    if (step.status !== 'COMPLETED' || !step.result || !step.result.success) {
      const msg = step.result?.error || step.errorMessage || 'Step did not complete successfully';
      errors.push(msg);
      return {
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        status: 'FAILED',
        schemaValid: false,
        errors,
        provenance,
        message: msg,
      };
    }

    const schemaCheck = validateOutputAgainstSchema(step.result.data, cap.outputSchema);
    if (!schemaCheck.valid) {
      return {
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        status: 'UNVERIFIED',
        schemaValid: false,
        errors: schemaCheck.errors,
        provenance,
        message: `Output schema validation failed: ${schemaCheck.errors.join('; ')}`,
      };
    }

    if (provenance.stale) {
      return {
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        status: 'STALE',
        schemaValid: true,
        errors: [],
        provenance,
        message: `${step.result.message} (${provenance.freshnessLabel})`,
      };
    }

    return {
      stepId: step.stepId,
      capabilityId: step.capabilityId,
      status: 'VERIFIED',
      schemaValid: true,
      errors: [],
      provenance,
      message: step.result.message,
    };
  }

  verifyTaskExecution(
    task: BackgroundTaskRecord,
    steps: TaskStepRecord[],
    registry: CapabilityRegistry
  ): TaskVerificationResult {
    const stepVerifications = steps.map((s) =>
      this.verifyStepResult(task, s, registry.get(s.capabilityId))
    );

    const totalSteps = stepVerifications.length;
    const completedSteps = stepVerifications.filter(
      (v) => v.status === 'VERIFIED' || v.status === 'STALE'
    ).length;
    const failedSteps = stepVerifications.filter(
      (v) => v.status === 'FAILED' || v.status === 'UNVERIFIED' || v.status === 'UNAVAILABLE'
    ).length;
    const waitingSteps = stepVerifications.filter(
      (v) => v.status === 'WAITING_FOR_APPROVAL'
    ).length;

    const allErrors = stepVerifications.flatMap((v) => v.errors);
    const provenance = stepVerifications.map((v) => v.provenance);

    let status: VerificationStatus;
    let partial = false;

    if (waitingSteps > 0) {
      status = 'WAITING_FOR_APPROVAL';
    } else if (totalSteps === 0) {
      status = 'UNVERIFIED';
    } else if (stepVerifications.every((v) => v.status === 'UNAVAILABLE')) {
      status = 'UNAVAILABLE';
    } else if (failedSteps > 0 && completedSteps > 0) {
      status = 'PARTIALLY_VERIFIED';
      partial = true;
    } else if (failedSteps > 0) {
      status = stepVerifications.some((v) => v.status === 'UNVERIFIED') &&
        !stepVerifications.some((v) => v.status === 'FAILED')
        ? 'UNVERIFIED'
        : 'FAILED';
    } else if (stepVerifications.every((v) => v.status === 'STALE')) {
      status = 'STALE';
    } else if (stepVerifications.some((v) => v.status === 'STALE')) {
      status = 'PARTIALLY_VERIFIED';
      partial = true;
    } else {
      status = 'VERIFIED';
    }

    const summary =
      status === 'VERIFIED'
        ? `Verified ${completedSteps}/${totalSteps} step(s) successfully.`
        : status === 'PARTIALLY_VERIFIED'
          ? `Partially verified: ${completedSteps}/${totalSteps} step(s) succeeded (${failedSteps} failed/unverified).`
          : status === 'WAITING_FOR_APPROVAL'
            ? `Paused waiting for approval on ${waitingSteps} step(s).`
            : status === 'STALE'
              ? `Completed ${completedSteps}/${totalSteps} step(s) with stale/cached data.`
              : `Verification failed (${allErrors[0] || status}).`;

    return {
      taskId: task.id,
      status,
      verifiedAt: new Date().toISOString(),
      summary,
      completedSteps,
      failedSteps,
      waitingSteps,
      totalSteps,
      partial,
      stepVerifications,
      provenance,
      errors: allErrors,
    };
  }
}

let _verifier: ResultVerifier | null = null;
export function getResultVerifier(): ResultVerifier {
  if (!_verifier) {
    _verifier = new ResultVerifier();
  }
  return _verifier;
}
