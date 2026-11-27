// ============================================================
// FRIDAY — Standard Presentation Contracts
// Strict JSON-only presentation schemas; rejects untrusted HTML/JS
// ============================================================

import { ProvenanceRecord, VerificationStatus } from '../orchestration/resultVerifier';

export type PresentationType =
  | 'chat'
  | 'summary'
  | 'metric'
  | 'table'
  | 'chart'
  | 'report'
  | 'notification'
  | 'approval'
  | 'error'
  | 'progress';

export interface PresentationAction {
  actionId: string;
  label: string;
  kind: 'approve' | 'reject' | 'cancel' | 'retry' | 'expand' | 'followup';
  approvalId?: string;
  taskId?: string;
  prompt?: string;
}

export interface PresentationContract {
  presentationId: string;
  taskId: string | null;
  conversationId: string | null;
  ownerId: string;
  presentationType: PresentationType;
  title: string;
  summary: string;
  data: Record<string, unknown>;
  verificationStatus: VerificationStatus;
  provenance: ProvenanceRecord[];
  actions: PresentationAction[];
  createdAt: string;
}

const VALID_PRESENTATION_TYPES = new Set<PresentationType>([
  'chat',
  'summary',
  'metric',
  'table',
  'chart',
  'report',
  'notification',
  'approval',
  'error',
  'progress',
]);

const VALID_VERIFICATION_STATUSES = new Set<VerificationStatus>([
  'VERIFIED',
  'PARTIALLY_VERIFIED',
  'UNVERIFIED',
  'FAILED',
  'UNAVAILABLE',
  'STALE',
  'WAITING_FOR_APPROVAL',
]);

const UNSAFE_HTML_JS_PATTERN =
  /<\s*\/?\s*(script|iframe|object|embed|svg|style|link|meta|form)\b|javascript\s*:|data\s*:\s*text\/html|on(?:error|load|click|mouseover|focus|submit)\s*=/i;

function scanForUnsafeMarkup(value: unknown, path: string, errors: string[]): void {
  if (typeof value === 'string') {
    if (UNSAFE_HTML_JS_PATTERN.test(value)) {
      errors.push(`Unsafe HTML/JS markup detected at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanForUnsafeMarkup(value[i], `${path}[${i}]`, errors);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scanForUnsafeMarkup(v, `${path}.${k}`, errors);
    }
  }
}

export function validatePresentationContract(
  contract: Partial<PresentationContract>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!contract.presentationId || typeof contract.presentationId !== 'string') {
    errors.push('presentationId is required');
  }
  if (!contract.presentationType || !VALID_PRESENTATION_TYPES.has(contract.presentationType)) {
    errors.push(`Invalid presentationType: ${String(contract.presentationType)}`);
  }
  if (!contract.verificationStatus || !VALID_VERIFICATION_STATUSES.has(contract.verificationStatus)) {
    errors.push(`Invalid verificationStatus: ${String(contract.verificationStatus)}`);
  }
  if (!contract.title || typeof contract.title !== 'string') {
    errors.push('title is required');
  }
  if (typeof contract.summary !== 'string') {
    errors.push('summary must be a string');
  }
  if (!contract.data || typeof contract.data !== 'object' || Array.isArray(contract.data)) {
    errors.push('data must be a plain JSON object');
  }

  scanForUnsafeMarkup(contract.title, 'title', errors);
  scanForUnsafeMarkup(contract.summary, 'summary', errors);
  scanForUnsafeMarkup(contract.data, 'data', errors);
  scanForUnsafeMarkup(contract.actions, 'actions', errors);

  return { valid: errors.length === 0, errors };
}
