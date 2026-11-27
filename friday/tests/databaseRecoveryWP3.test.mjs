import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-wp3-db-'));
const dbPath = path.join(tmpDir, 'friday-wp3.db');
const backupPath = path.join(tmpDir, 'friday-wp3-backup.db');
process.env.FRIDAY_DB_PATH = dbPath;

const { getMemoryStore } = await import('../dist/memory/store.js');
const { runMigrations } = await import('../dist/memory/migrations.js');
const { getPersonalIdentityService } = await import('../dist/identity/identityService.js');
const { getProjectContextService } = await import('../dist/identity/projectContextService.js');
const { getContinuousLearningEngine } = await import('../dist/learning/learningEngine.js');

describe('WP3/WP6 Database Reliability: Migrations, Backup, Restore & Transaction Safety', () => {
  before(async () => {
    const store = await getMemoryStore();
    await store.initialize();
  });

  after(async () => {
    const store = await getMemoryStore();
    store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore Windows temp cleanup delay
    }
  });

  it('applies migrations idempotently without duplicating schema_migrations', async () => {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const beforeRows = db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get();
    assert.equal(beforeRows.c, 13);

    // Re-running migrations must be a no-op
    runMigrations(db);
    const afterRows = db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get();
    assert.equal(afterRows.c, 13);
  });

  it('preserves identity, projects, learning & procedures across backup and simulated corruption restore', async () => {
    const store = await getMemoryStore();
    const actor = 'wp3-owner';

    await getPersonalIdentityService().createOrUpdateProfile(actor, {
      preferredAddress: 'Boss',
      goals: ['Reliable Daily Driver'],
    });
    await getProjectContextService().upsertProject(actor, {
      projectName: 'FRIDAY-Release',
      techStack: ['TypeScript', 'SQLite'],
      setActive: true,
    });
    await getContinuousLearningEngine().ingest({
      actorId: actor,
      sourceType: 'user_file',
      sourceRef: 'runbook.md',
      subject: 'Backup policy',
      rawContent: 'Verify SQLite backups before upgrades.',
    });

    // Create verified backup
    const dest = await store.backupDatabase(backupPath);
    assert.equal(fs.existsSync(dest), true);

    // Simulate primary DB corruption / data loss
    store.close();
    fs.writeFileSync(dbPath, 'CORRUPTED_BINARY_DATA_0000');

    // Restore from backup
    fs.copyFileSync(backupPath, dbPath);
    await store.initialize();

    const restoredProf = await getPersonalIdentityService().getProfile(actor);
    assert.equal(restoredProf.preferredAddress, 'Boss');
    assert.deepEqual(restoredProf.goals, ['Reliable Daily Driver']);

    const restoredProj = await getProjectContextService().getActiveProject(actor);
    assert.equal(restoredProj?.projectName, 'FRIDAY-Release');

    const restoredLearn = await getContinuousLearningEngine().retrieve({ actorId: actor, query: 'Backup' });
    assert.equal(restoredLearn.length, 1);
  });

  it('rolls back failed SQLite transactions atomically', async () => {
    const store = await getMemoryStore();
    const db = store.getDatabase();
    const countBefore = db.prepare(`SELECT COUNT(*) as c FROM project_contexts`).get().c;

    const badTx = db.transaction(() => {
      db.prepare(
        `INSERT INTO project_contexts (id, actor_id, project_name) VALUES ('tx-test-1', 'tx-actor', 'TempProj')`
      ).run();
      throw new Error('Simulated crash mid-transaction');
    });

    assert.throws(() => badTx(), /Simulated crash/);
    const countAfter = db.prepare(`SELECT COUNT(*) as c FROM project_contexts`).get().c;
    assert.equal(countAfter, countBefore);
  });
});
