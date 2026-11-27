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
  untrustedSanitized: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LearnedProcedureRecord {
  id: string;
  actorId: string;
  name: string;
  description: string;
  steps: string[];
  requiresApproval: boolean;
  approvedByUser: boolean;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
