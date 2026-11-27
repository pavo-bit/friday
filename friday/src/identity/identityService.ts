// ============================================================
// FRIDAY — Personal Identity Service
// Persistent, actor-isolated personal digital identity profile
// ============================================================

import { getMemoryStore } from '../memory/store';
import { getAuthService } from '../services/authService';
import {
  DEFAULT_PERSONAL_IDENTITY,
  PersonalIdentityProfile,
  PrivacyPreferences,
} from './identityProfile';
import { validateIdentityArray, validateIdentityText } from './identityPolicy';

export class PersonalIdentityService {
  async getProfile(actorId: string): Promise<PersonalIdentityProfile> {
    if (!actorId || !actorId.trim()) {
      throw new Error('actorId is required');
    }
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) {
      return { actorId, ...DEFAULT_PERSONAL_IDENTITY };
    }

    const row = db
      .prepare(`SELECT * FROM personal_identities WHERE actor_id = ?`)
      .get(actorId) as Record<string, unknown> | undefined;

    if (!row) {
      return this.createOrUpdateProfile(actorId, {});
    }

    return {
      actorId: String(row.actor_id),
      preferredAddress: String(row.preferred_address || 'Boss'),
      explanationStyle: (row.explanation_style as PersonalIdentityProfile['explanationStyle']) || 'progressive',
      goals: JSON.parse(String(row.goals_json || '[]')),
      approvedApps: JSON.parse(String(row.approved_apps_json || '[]')),
      privacy: JSON.parse(String(row.privacy_json || JSON.stringify(DEFAULT_PERSONAL_IDENTITY.privacy))),
      workingContext: String(row.working_context || ''),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async createOrUpdateProfile(
    actorId: string,
    update: Partial<{
      preferredAddress: string;
      explanationStyle: PersonalIdentityProfile['explanationStyle'];
      goals: string[];
      approvedApps: string[];
      privacy: Partial<PrivacyPreferences>;
      workingContext: string;
    }>
  ): Promise<PersonalIdentityProfile> {
    if (!actorId || !actorId.trim()) {
      throw new Error('actorId is required');
    }

    const store = await getMemoryStore();
    const db = store.getDatabase();

    let existing: PersonalIdentityProfile | null = null;
    if (db) {
      const row = db
        .prepare(`SELECT * FROM personal_identities WHERE actor_id = ?`)
        .get(actorId) as Record<string, unknown> | undefined;
      if (row) {
        existing = {
          actorId: String(row.actor_id),
          preferredAddress: String(row.preferred_address || 'Boss'),
          explanationStyle:
            (row.explanation_style as PersonalIdentityProfile['explanationStyle']) || 'progressive',
          goals: JSON.parse(String(row.goals_json || '[]')),
          approvedApps: JSON.parse(String(row.approved_apps_json || '[]')),
          privacy: JSON.parse(String(row.privacy_json || JSON.stringify(DEFAULT_PERSONAL_IDENTITY.privacy))),
          workingContext: String(row.working_context || ''),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        };
      }
    }

    const preferredAddress =
      update.preferredAddress !== undefined
        ? validateIdentityText('preferredAddress', update.preferredAddress) || 'Boss'
        : existing?.preferredAddress ?? DEFAULT_PERSONAL_IDENTITY.preferredAddress;

    const validStyles = new Set(['progressive', 'direct', 'socratic', 'example_first']);
    const explanationStyle =
      update.explanationStyle !== undefined
        ? validStyles.has(update.explanationStyle)
          ? update.explanationStyle
          : (() => {
              throw new Error(`Invalid explanationStyle: ${update.explanationStyle}`);
            })()
        : existing?.explanationStyle ?? DEFAULT_PERSONAL_IDENTITY.explanationStyle;

    const goals =
      update.goals !== undefined
        ? validateIdentityArray('goals', update.goals)
        : existing?.goals ?? DEFAULT_PERSONAL_IDENTITY.goals;

    const approvedApps =
      update.approvedApps !== undefined
        ? validateIdentityArray('approvedApps', update.approvedApps)
        : existing?.approvedApps ?? DEFAULT_PERSONAL_IDENTITY.approvedApps;

    const workingContext =
      update.workingContext !== undefined
        ? validateIdentityText('workingContext', update.workingContext)
        : existing?.workingContext ?? DEFAULT_PERSONAL_IDENTITY.workingContext;

    const basePrivacy = existing?.privacy ?? DEFAULT_PERSONAL_IDENTITY.privacy;
    const privacy: PrivacyPreferences = {
      allowLearning: update.privacy?.allowLearning ?? basePrivacy.allowLearning,
      allowProjectTracking: update.privacy?.allowProjectTracking ?? basePrivacy.allowProjectTracking,
      redactSensitive: update.privacy?.redactSensitive ?? basePrivacy.redactSensitive,
    };

    if (db) {
      db.prepare(
        `INSERT INTO personal_identities (
           actor_id, preferred_address, explanation_style, goals_json,
           approved_apps_json, privacy_json, working_context, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(actor_id) DO UPDATE SET
           preferred_address = excluded.preferred_address,
           explanation_style = excluded.explanation_style,
           goals_json = excluded.goals_json,
           approved_apps_json = excluded.approved_apps_json,
           privacy_json = excluded.privacy_json,
           working_context = excluded.working_context,
           updated_at = datetime('now')`
      ).run(
        actorId,
        preferredAddress,
        explanationStyle,
        JSON.stringify(goals),
        JSON.stringify(approvedApps),
        JSON.stringify(privacy),
        workingContext
      );
    }

    return this.getProfile(actorId);
  }

  async inspectIdentityBundle(actorId: string): Promise<{
    profile: PersonalIdentityProfile;
    connectedDevices: Array<{ id: string; name: string; platform: string; lastSeenAt: string }>;
  }> {
    const profile = await this.getProfile(actorId);
    const devices = await getAuthService().listDevices();
    return {
      profile,
      connectedDevices: devices
        .filter((d) => !d.ownerId || d.ownerId === actorId || actorId === 'local')
        .map((d) => ({
          id: d.id,
          name: d.name,
          platform: d.platform,
          lastSeenAt: d.lastSeenAt,
        })),
    };
  }
}

let _identitySvc: PersonalIdentityService | null = null;
export function getPersonalIdentityService(): PersonalIdentityService {
  if (!_identitySvc) {
    _identitySvc = new PersonalIdentityService();
  }
  return _identitySvc;
}
