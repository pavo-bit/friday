// ============================================================
// FRIDAY — Digital Identity & Personality Types
// Core types and locked defaults for Phase 13
// ============================================================

export type PersonalityMode =
  | 'ADAPTIVE'
  | 'TEACHER'
  | 'FRIEND'
  | 'COMPANION'
  | 'TECHNICAL_EXPERT'
  | 'PROFESSIONAL_ASSISTANT';

export type ActivePersonalityProfile = Exclude<PersonalityMode, 'ADAPTIVE'>;

export type CommunicationStyle = 'NATURAL' | 'WARM' | 'DIRECT' | 'FORMAL';

export type ResponseDepthMode = 'ADAPTIVE' | 'CONCISE' | 'BALANCED' | 'DETAILED';
export type ResolvedResponseDepth = 'CONCISE' | 'BALANCED' | 'DETAILED';

export type InteractionChannel = 'text' | 'voice' | 'desktop' | 'android';

export type ConversationalCategory =
  | 'general_question'
  | 'learning_request'
  | 'technical_problem'
  | 'personal_discussion'
  | 'research_request'
  | 'creative_request'
  | 'task_execution'
  | 'casual_conversation'
  | 'follow_up'
  | 'clarification'
  | 'emotional_support';

export interface DigitalIdentitySettings {
  actorId: string;
  defaultPersonality: PersonalityMode;
  communicationStyle: CommunicationStyle;
  answerDetail: ResponseDepthMode;
  voiceConciseMode: boolean;
  conversationContinuity: boolean;
  memoryAutoLearn: boolean;
  updatedAt?: string;
}

export const LOCKED_IDENTITY_DEFAULTS: Omit<DigitalIdentitySettings, 'actorId' | 'updatedAt'> = {
  defaultPersonality: 'ADAPTIVE',
  communicationStyle: 'NATURAL',
  answerDetail: 'ADAPTIVE',
  voiceConciseMode: true,
  conversationContinuity: true,
  memoryAutoLearn: true,
};

export interface PersonalitySelectionResult {
  primaryProfile: ActivePersonalityProfile;
  secondaryProfile?: ActivePersonalityProfile;
  configuredMode: PersonalityMode;
  communicationStyle: CommunicationStyle;
  isTemporaryOverride: boolean;
  reason: string;
  confidence: number;
}

export interface DepthSelectionResult {
  depth: ResolvedResponseDepth;
  configuredMode: ResponseDepthMode;
  isTemporaryOverride: boolean;
  reason: string;
  maxVoiceSentences: number;
}

export interface PersonalityMetadata {
  activeProfile: ActivePersonalityProfile;
  secondaryProfile?: ActivePersonalityProfile;
  configuredMode: PersonalityMode;
  communicationStyle: CommunicationStyle;
  depth: ResolvedResponseDepth;
  isTemporaryOverride: boolean;
  selectionReason: string;
  voiceSummary?: string;
}
