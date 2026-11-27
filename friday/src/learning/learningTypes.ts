// ============================================================
// FRIDAY — Continuous Learning Types (Phase 13.5)
// ============================================================

export type LearningKind =
  | 'memory'
  | 'knowledge'
  | 'preference'
  | 'procedure'
  | 'fine_tune_candidate';

export type SourceQuality =
  | 'VERIFIED_FACT'
  | 'USER_STATEMENT'
  | 'EXTERNAL_CLAIM'
  | 'INFERENCE'
  | 'UNVERIFIED'
  | 'OUTDATED';

export type LearningSourceType =
  | 'user_file'
  | 'approved_directory'
  | 'approved_website'
  | 'connected_app'
  | 'conversation_correction'
  | 'verified_task_outcome'
  | 'monitoring_event';

export interface LearningIngestInput {
  actorId: string;
  sourceType: LearningSourceType;
  sourceRef: string;
  subject: string;
  rawContent: string;
  projectName?: string;
  declaredQuality?: SourceQuality;
  explicitKind?: LearningKind;
  approvedSource?: boolean;
  evidence?: string[];
  expiresAt?: string;
}

export interface LearningRecord {
  id: string;
  actorId: string;
  learningKind: LearningKind;
  sourceType: LearningSourceType;
  sourceRef: string;
  sourceQuality: SourceQuality;
  subject: string;
  content: string;
  projectName: string;
  confidence: number;
  verified: boolean;
  approvedByUser: boolean;
  evidence: string[];
  version: number;
  untrustedSanitized: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LearningContradictionRecord {
  id: string;
  actorId: string;
  existingRecordId: string;
  conflictingContent: string;
  conflictingSourceType: string;
  conflictingSourceRef: string;
  projectName: string;
  status: 'OPEN' | 'RESOLVED_KEEP_EXISTING' | 'RESOLVED_USE_NEW';
  createdAt: string;
  resolvedAt: string | null;
}

export interface LearningVersionRecord {
  id: string;
  recordId: string;
  actorId: string;
  version: number;
  previousContent: string;
  newContent: string;
  reason: string;
  changedAt: string;
}

export interface LearnedProcedureRecord {
  id: string;
  actorId: string;
  name: string;
  description: string;
  steps: string[];
  sourceRef: string;
  scope: string;
  requiredPermissions: string[];
  version: number;
  requiresApproval: boolean;
  approvedByUser: boolean;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProcedureExecutionRecord {
  id: string;
  procedureId: string;
  actorId: string;
  authorized: boolean;
  status: 'BLOCKED' | 'COMPLETED' | 'FAILED';
  output: string;
  executedAt: string;
}
