import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openSqliteStorage } from './index.js';
it('upgrades twelve migrations and preserves old policy with push denied', () => {
  const root = mkdtempSync(join(tmpdir(), 'push-migration-'));
  let storage: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    const folder = join(root, 'old');
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.slice(0, 12);
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(
        new URL('../drizzle/' + entry.tag + '.sql', import.meta.url),
        join(folder, entry.tag + '.sql'),
      );
    const filename = join(root, 'state.sqlite');
    storage = openSqliteStorage({ filename, migrationsFolder: folder });
    const at = '2026-10-22T00:00:00Z';
    const project = storage.repositories.projects.upsert({
      id: 'p',
      name: 'Existing',
      createdAt: at,
      updatedAt: at,
    });
    const old = {
      id: 'p',
      revision: 2,
      tools: { control_delegate_task: 'deny' },
      gitMerge: 'deny',
      requireEnforcedExecution: false,
      updatedAt: at,
    };
    storage.sqlite
      .prepare('INSERT INTO project_policies (id, payload) VALUES (?, ?)')
      .run('p', JSON.stringify(old));
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.repositories.projects.get('p')).toEqual(project);
    expect(storage.repositories.workspacePushes.list()).toEqual([]);
    expect(storage.repositories.projectPolicies.get('p')).toEqual({
      ...old,
      gitPush: 'deny',
      agentPermissions: { workspaceFiles: 'ask', commands: 'ask', outsideWorkspace: 'ask' },
    });
    const migrated = storage.repositories.projectPolicies.get('p')!;
    storage.repositories.projectPolicies.upsert({
      ...migrated,
      agentPermissions: { ...migrated.agentPermissions, workspaceFiles: 'auto' },
    });
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.repositories.projectPolicies.get('p')?.agentPermissions.workspaceFiles).toBe(
      'auto',
    );
    expect(storage.sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 19,
    });
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    if (storage?.sqlite.open) storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
