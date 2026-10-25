import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  openSqliteStorage,
  createConsistentSqliteSnapshot,
  inspectSqliteSnapshot,
} from './index.js';

it('preserves legacy assignment directories through migration, reopen and backup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assignment-workspace-migration-'));
  let storage: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    const folder = join(root, 'old');
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.slice(0, 8);
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(
        new URL('../drizzle/' + entry.tag + '.sql', import.meta.url),
        join(folder, entry.tag + '.sql'),
      );
    const filename = join(root, 'state.sqlite'),
      at = '2026-10-22T00:00:00Z';
    storage = openSqliteStorage({ filename, migrationsFolder: folder });
    storage.repositories.projects.upsert({
      id: 'p',
      name: 'Existing project',
      createdAt: at,
      updatedAt: at,
    });
    storage.repositories.workspaces.upsert({
      id: 'w',
      projectId: 'p',
      provider: 'local-directory',
      rootPath: join(root, 'original'),
      access: 'read-write',
    });
    storage.repositories.tasks.upsert({
      id: 't',
      projectId: 'p',
      title: 'Keep work',
      objective: 'Preserve files',
      state: 'waiting',
      dependencyIds: [],
      contextRefs: [],
      resultArtifactRefs: [],
      createdAt: at,
      updatedAt: at,
    });
    const original = storage.repositories.assignments.upsert({
      id: 'a',
      taskId: 't',
      agentId: 'agent',
      objective: 'Preserve files',
      state: 'waiting',
      attempt: 1,
      createdAt: at,
      updatedAt: at,
    });
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.repositories.projectWorkspaceConfigs.get('p')).toMatchObject({
      sourceWorkspaceId: 'w',
      mode: 'unconfigured',
    });
    expect(storage.repositories.assignmentWorkspaces.get('a')).toMatchObject({
      workspaceId: 'w',
      sourceWorkspaceId: 'w',
      mode: 'shared-directory',
    });
    expect(storage.repositories.assignments.get('a')).toEqual(original);
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([]);
    storage.close();
    await createConsistentSqliteSnapshot(filename, join(root, 'snapshot.sqlite'));
    expect(inspectSqliteSnapshot(join(root, 'snapshot.sqlite')).migrations).toHaveLength(19);
    storage = openSqliteStorage({ filename: join(root, 'snapshot.sqlite') });
    expect(storage.repositories.assignmentWorkspaces.get('a')?.workspaceId).toBe('w');
  } finally {
    if (storage?.sqlite.open) storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
