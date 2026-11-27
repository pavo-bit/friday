// ============================================================
// FRIDAY — Personal Identity Profile Types & Defaults
// ============================================================

export interface PrivacyPreferences {
  allowLearning: boolean;
  allowProjectTracking: boolean;
  redactSensitive: boolean;
}

export interface PersonalIdentityProfile {
  actorId: string;
  preferredAddress: string;
  explanationStyle: 'progressive' | 'direct' | 'socratic' | 'example_first';
  goals: string[];
  approvedApps: string[];
  privacy: PrivacyPreferences;
  workingContext: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectContextRecord {
  id: string;
  actorId: string;
  projectName: string;
  repoPath: string;
  techStack: string[];
  architectureSummary: string;
  progressSummary: string;
  blockers: string[];
  recentDecisions: string[];
  docsPaths: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_PERSONAL_IDENTITY: Omit<PersonalIdentityProfile, 'actorId' | 'createdAt' | 'updatedAt'> = {
  preferredAddress: 'Boss',
  explanationStyle: 'progressive',
  goals: [],
  approvedApps: [],
  privacy: {
    allowLearning: true,
    allowProjectTracking: true,
    redactSensitive: true,
  },
  workingContext: '',
};
