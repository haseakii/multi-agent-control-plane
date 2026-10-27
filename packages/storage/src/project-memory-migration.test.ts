import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  openSqliteStorage,
  SqliteContextSearch,
  createConsistentSqliteSnapshot,
  inspectSqliteSnapshot,
} from './index.js';

it('migrates an existing project to curated searchable memory and preserves it through backup/reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-memory-migration-'));
  let storage: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    const folder = join(root, 'old');
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.slice(0, 9);
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(
        new URL('../drizzle/' + entry.tag + '.sql', import.meta.url),
        join(folder, entry.tag + '.sql'),
      );
    const filename = join(root, 'state.sqlite'),
      at = '2026-10-22T00:00:00Z';
    storage = openSqliteStorage({ filename, migrationsFolder: folder });
    const project = storage.repositories.projects.upsert({
      id: 'p',
      name: 'Existing project',
      createdAt: at,
      updatedAt: at,
    });
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.repositories.projects.get('p')).toEqual(project);
    const entry = storage.repositories.projectMemory.upsert({
      id: 'm',
      projectId: 'p',
      kind: 'constraint',
      title: '离线运行要求',
      content: '所有项目必须支持离线运行。',
      status: 'proposed',
      proposedBy: { type: 'user', id: 'local-operator' },
      createdAt: at,
      updatedAt: at,
    });
    const index = new SqliteContextSearch(storage.sqlite);
    expect(index.search('p', { query: '离线运行', limit: 20 })).toEqual([]);
    const accepted = storage.repositories.projectMemory.upsert({
      ...entry,
      status: 'accepted',
      reviewedBy: entry.proposedBy,
      reviewedAt: at,
    });
    expect(index.search('p', { query: '离线运行', limit: 20 })).toMatchObject([
      { id: 'm', source: 'memory' },
    ]);
    expect(index.search('p', { query: '离线', limit: 20 })).toHaveLength(1);
    expect(index.search('another-project', { query: '离线运行', limit: 20 })).toEqual([]);
    storage.close();
    await createConsistentSqliteSnapshot(filename, join(root, 'snapshot.sqlite'));
    expect(inspectSqliteSnapshot(join(root, 'snapshot.sqlite')).migrations).toHaveLength(23);
    storage = openSqliteStorage({ filename: join(root, 'snapshot.sqlite') });
    expect(storage.repositories.projectMemory.get('m')).toEqual(accepted);
    expect(
      new SqliteContextSearch(storage.sqlite).search('p', { query: '离线运行', limit: 20 }),
    ).toHaveLength(1);
  } finally {
    if (storage?.sqlite.open) storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
