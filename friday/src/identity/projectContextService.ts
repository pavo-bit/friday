// ============================================================
// FRIDAY — Cross-Project Context Service (Phase 13.8)
// Strict project-boundary isolation, switching, and comparison
// ============================================================

import { v4 as uuidv4 } from 'uuid';
import { getMemoryStore } from '../memory/store';
import { ProjectContextRecord } from './identityProfile';
import { validateIdentityArray, validateIdentityText } from './identityPolicy';

export class ProjectContextService {
  private mapRow(row: Record<string, unknown>): ProjectContextRecord {
    return {
      id: String(row.id),
      actorId: String(row.actor_id),
      projectName: String(row.project_name),
      repoPath: String(row.repo_path || ''),
      techStack: JSON.parse(String(row.tech_stack_json || '[]')),
      architectureSummary: String(row.architecture_summary || ''),
      progressSummary: String(row.progress_summary || ''),
      blockers: JSON.parse(String(row.blockers_json || '[]')),
      recentDecisions: JSON.parse(String(row.recent_decisions_json || '[]')),
      docsPaths: JSON.parse(String(row.docs_paths_json || '[]')),
      isActive: Number(row.is_active) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  async upsertProject(
    actorId: string,
    input: {
      projectName: string;
      repoPath?: string;
      techStack?: string[];
      architectureSummary?: string;
      progressSummary?: string;
      blockers?: string[];
      recentDecisions?: string[];
      docsPaths?: string[];
      setActive?: boolean;
    }
  ): Promise<ProjectContextRecord> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const projectName = validateIdentityText('projectName', input.projectName);
    if (!projectName) throw new Error('projectName is required');

    const repoPath = input.repoPath ? validateIdentityText('repoPath', input.repoPath) : '';
    const techStack = input.techStack ? validateIdentityArray('techStack', input.techStack) : [];
    const architectureSummary = input.architectureSummary
      ? validateIdentityText('architectureSummary', input.architectureSummary)
      : '';
    const progressSummary = input.progressSummary
      ? validateIdentityText('progressSummary', input.progressSummary)
      : '';
    const blockers = input.blockers ? validateIdentityArray('blockers', input.blockers) : [];
    const recentDecisions = input.recentDecisions
      ? validateIdentityArray('recentDecisions', input.recentDecisions)
      : [];
    const docsPaths = input.docsPaths ? validateIdentityArray('docsPaths', input.docsPaths) : [];

    const existing = db
      .prepare(`SELECT * FROM project_contexts WHERE actor_id = ? AND LOWER(project_name) = LOWER(?)`)
      .get(actorId, projectName) as Record<string, unknown> | undefined;

    const id = existing ? String(existing.id) : uuidv4();
    const tx = db.transaction(() => {
      if (input.setActive) {
        db.prepare(`UPDATE project_contexts SET is_active = 0 WHERE actor_id = ?`).run(actorId);
      }
      db.prepare(
        `INSERT INTO project_contexts (
           id, actor_id, project_name, repo_path, tech_stack_json,
           architecture_summary, progress_summary, blockers_json,
           recent_decisions_json, docs_paths_json, is_active, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(actor_id, project_name) DO UPDATE SET
           repo_path = CASE WHEN excluded.repo_path != '' THEN excluded.repo_path ELSE project_contexts.repo_path END,
           tech_stack_json = CASE WHEN excluded.tech_stack_json != '[]' THEN excluded.tech_stack_json ELSE project_contexts.tech_stack_json END,
           architecture_summary = CASE WHEN excluded.architecture_summary != '' THEN excluded.architecture_summary ELSE project_contexts.architecture_summary END,
           progress_summary = CASE WHEN excluded.progress_summary != '' THEN excluded.progress_summary ELSE project_contexts.progress_summary END,
           blockers_json = CASE WHEN excluded.blockers_json != '[]' THEN excluded.blockers_json ELSE project_contexts.blockers_json END,
           recent_decisions_json = CASE WHEN excluded.recent_decisions_json != '[]' THEN excluded.recent_decisions_json ELSE project_contexts.recent_decisions_json END,
           docs_paths_json = CASE WHEN excluded.docs_paths_json != '[]' THEN excluded.docs_paths_json ELSE project_contexts.docs_paths_json END,
           is_active = CASE WHEN ? = 1 THEN 1 ELSE project_contexts.is_active END,
           updated_at = datetime('now')`
      ).run(
        id,
        actorId,
        projectName,
        repoPath,
        JSON.stringify(techStack),
        architectureSummary,
        progressSummary,
        JSON.stringify(blockers),
        JSON.stringify(recentDecisions),
        JSON.stringify(docsPaths),
        input.setActive ? 1 : 0,
        input.setActive ? 1 : 0
      );
    });
    tx();

    const row = db
      .prepare(`SELECT * FROM project_contexts WHERE id = ? AND actor_id = ?`)
      .get(id, actorId) as Record<string, unknown>;
    return this.mapRow(row);
  }

  async listProjects(actorId: string): Promise<ProjectContextRecord[]> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return [];
    const rows = db
      .prepare(`SELECT * FROM project_contexts WHERE actor_id = ? ORDER BY is_active DESC, updated_at DESC`)
      .all(actorId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRow(r));
  }

  async getActiveProject(actorId: string): Promise<ProjectContextRecord | null> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) return null;
    const row = db
      .prepare(`SELECT * FROM project_contexts WHERE actor_id = ? AND is_active = 1 LIMIT 1`)
      .get(actorId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  async switchProject(actorId: string, projectNameQuery: string): Promise<{
    switched: boolean;
    project: ProjectContextRecord | null;
    message: string;
  }> {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    if (!db) throw new Error('Database unavailable');

    const clean = projectNameQuery.trim().toLowerCase();
    const projects = await this.listProjects(actorId);
    const match = projects.find(
      (p) => p.projectName.toLowerCase() === clean || p.projectName.toLowerCase().includes(clean)
    );

    if (!match) {
      return {
        switched: false,
        project: null,
        message: `No connected project matching "${projectNameQuery}" found for your account. I cannot access or fabricate progress for unconnected repositories.`,
      };
    }

    db.transaction(() => {
      db.prepare(`UPDATE project_contexts SET is_active = 0 WHERE actor_id = ?`).run(actorId);
      db.prepare(`UPDATE project_contexts SET is_active = 1, updated_at = datetime('now') WHERE id = ? AND actor_id = ?`).run(
        match.id,
        actorId
      );
    })();

    const updated = { ...match, isActive: true };
    return {
      switched: true,
      project: updated,
      message: `Switched active project context to "${updated.projectName}"${updated.techStack.length ? ` (${updated.techStack.join(', ')})` : ''}. Progress: ${updated.progressSummary || 'No progress summary recorded yet.'}`,
    };
  }

  async compareProjects(actorId: string, nameA?: string, nameB?: string): Promise<{
    compared: boolean;
    projects: ProjectContextRecord[];
    summary: string;
  }> {
    const all = await this.listProjects(actorId);
    if (all.length < 2) {
      return {
        compared: false,
        projects: all,
        summary: 'At least two connected projects are needed to compare project contexts.',
      };
    }

    const findOne = (q?: string) =>
      q
        ? all.find((p) => p.projectName.toLowerCase() === q.toLowerCase() || p.projectName.toLowerCase().includes(q.toLowerCase()))
        : undefined;

    const projA = findOne(nameA) || all[0];
    const projB = findOne(nameB) || all.find((p) => p.id !== projA.id)!;

    const summary = [
      `Project Comparison (${projA.projectName} vs ${projB.projectName}):`,
      `1. ${projA.projectName}: Stack [${projA.techStack.join(', ') || 'unspecified'}] · Progress: ${projA.progressSummary || 'none recorded'} · Blockers: ${projA.blockers.length}`,
      `2. ${projB.projectName}: Stack [${projB.techStack.join(', ') || 'unspecified'}] · Progress: ${projB.progressSummary || 'none recorded'} · Blockers: ${projB.blockers.length}`,
    ].join('\n');

    return { compared: true, projects: [projA, projB], summary };
  }
}

let _projSvc: ProjectContextService | null = null;
export function getProjectContextService(): ProjectContextService {
  if (!_projSvc) {
    _projSvc = new ProjectContextService();
  }
  return _projSvc;
}
