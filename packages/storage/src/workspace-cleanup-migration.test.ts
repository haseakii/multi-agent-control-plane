import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openSqliteStorage } from './index.js';
it('upgrades thirteen migrations without deleting existing project data', () => {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-migration-'));
  let storage: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    const folder = join(root, 'old');
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.slice(0, 13);
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(
        new URL('../drizzle/' + entry.tag + '.sql', import.meta.url),
        join(folder, entry.tag + '.sql'),
      );
    const filename = join(root, 'state.sqlite');
    storage = openSqliteStorage({ filename, migrationsFolder: folder });
    const project = storage.repositories.projects.upsert({
      id: 'p',
      name: 'Preserved',
      createdAt: '2026-10-22T00:00:00Z',
      updatedAt: '2026-10-22T00:00:00Z',
    });
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.repositories.projects.get('p')).toEqual(project);
    expect(storage.repositories.workspaceCleanups.list()).toEqual([]);
    expect(storage.sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 18,
    });
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    if (storage?.sqlite.open) storage.close();
    const target = resolve(root);
    if (!relative(resolve(tmpdir()), target).startsWith('cleanup-migration-'))
      throw Error('Unexpected fixture');
    rmSync(target, { recursive: true, force: true });
  }
});
