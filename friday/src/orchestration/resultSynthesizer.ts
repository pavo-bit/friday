// ============================================================
// FRIDAY — Compound Result Synthesizer
// Honest, deterministic synthesis across multi-step outcomes
// ============================================================

import { TaskStepRecord } from './backgroundOrchestrator';
import { TaskVerificationResult } from './resultVerifier';

export interface SynthesizedResponse {
  overallStatus:
    | 'COMPLETED'
    | 'PARTIAL'
    | 'WAITING_FOR_APPROVAL'
    | 'FAILED'
    | 'UNVERIFIED'
    | 'UNAVAILABLE';
  summary: string;
  succeededSteps: string[];
  failedSteps: string[];
  skippedSteps: string[];
  waitingSteps: string[];
}

export function synthesizeTaskOutcome(params: {
  userName: string;
  steps: TaskStepRecord[];
  verification?: TaskVerificationResult;
  unavailableCapabilities?: string[];
}): SynthesizedResponse {
  const { userName, steps, verification, unavailableCapabilities = [] } = params;

  const succeededSteps = steps.filter((s) => s.status === 'COMPLETED').map((s) => s.stepId);
  const failedSteps = steps
    .filter((s) => s.status === 'FAILED' || s.status === 'TIMED_OUT' || s.status === 'INTERRUPTED')
    .map((s) => s.stepId);
  const skippedSteps = steps.filter((s) => s.status === 'SKIPPED' || s.status === 'CANCELLED').map((s) => s.stepId);
  const waitingSteps = steps.filter((s) => s.status === 'WAITING_FOR_APPROVAL').map((s) => s.stepId);

  if (unavailableCapabilities.length > 0 && steps.length === 0) {
    return {
      overallStatus: 'UNAVAILABLE',
      summary: `${userName}, the required capability is currently unavailable: ${unavailableCapabilities.join(', ')}.`,
      succeededSteps,
      failedSteps,
      skippedSteps,
      waitingSteps,
    };
  }

  if (waitingSteps.length > 0 || verification?.status === 'WAITING_FOR_APPROVAL') {
    return {
      overallStatus: 'WAITING_FOR_APPROVAL',
      summary: `${userName}, execution is paused waiting for your explicit approval on ${waitingSteps.join(', ')}.`,
      succeededSteps,
      failedSteps,
      skippedSteps,
      waitingSteps,
    };
  }

  if (verification?.status === 'UNVERIFIED') {
    return {
      overallStatus: 'UNVERIFIED',
      summary: `${userName}, execution finished but output verification failed: ${verification.errors.join('; ') || verification.summary}`,
      succeededSteps,
      failedSteps,
      skippedSteps,
      waitingSteps,
    };
  }

  if (failedSteps.length > 0 && succeededSteps.length > 0) {
    const failedDetails = steps
      .filter((s) => failedSteps.includes(s.stepId))
      .map((s) => `${s.stepId} (${s.errorMessage || s.status})`)
      .join('; ');
    return {
      overallStatus: 'PARTIAL',
      summary: `${userName}, partial completion: succeeded [${succeededSteps.join(', ')}], failed [${failedDetails}]${skippedSteps.length ? `, skipped [${skippedSteps.join(', ')}]` : ''}.`,
      succeededSteps,
      failedSteps,
      skippedSteps,
      waitingSteps,
    };
  }

  if (failedSteps.length > 0) {
    const failedDetails = steps
      .filter((s) => failedSteps.includes(s.stepId))
      .map((s) => `${s.stepId}: ${s.errorMessage || s.status}`)
      .join('; ');
    return {
      overallStatus: 'FAILED',
      summary: `${userName}, execution failed: ${failedDetails}.`,
      succeededSteps,
      failedSteps,
      skippedSteps,
      waitingSteps,
    };
  }

  const stepMessages = steps
    .filter((s) => s.status === 'COMPLETED' && s.result?.message)
    .map((s) => s.result!.message)
    .join(' · ');

  return {
    overallStatus: 'COMPLETED',
    summary: stepMessages || `${userName}, all ${succeededSteps.length} step(s) completed and verified.`,
    succeededSteps,
    failedSteps,
    skippedSteps,
    waitingSteps,
  };
}
