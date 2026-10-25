import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openSqliteStorage } from './index.js';
it('upgrades eleven migrations to project policy storage without changing project records', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-migration-'));
  let storage: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    const folder = join(root, 'old');
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.slice(0, 11);
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
      name: 'Existing',
      createdAt: '2026-10-22T00:00:00Z',
      updatedAt: '2026-10-22T00:00:00Z',
    });
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.repositories.projects.get('p')).toEqual(project);
    expect(storage.repositories.projectPolicies.list()).toEqual([]);
    expect(storage.sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 19,
    });
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([]);
  } finally {
    if (storage?.sqlite.open) storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
