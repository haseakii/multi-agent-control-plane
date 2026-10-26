import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { openSqliteStorage } from './index.js';

it('upgrades existing event history with indexed selection, stable order and no payload changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'event-selection-migration-'));
  let storage: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    const folder = join(root, 'old');
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.slice(0, 14);
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(
        new URL('../drizzle/' + entry.tag + '.sql', import.meta.url),
        join(folder, entry.tag + '.sql'),
      );
    const filename = join(root, 'state.sqlite');
    storage = openSqliteStorage({ filename, migrationsFolder: folder });
    const append = (id: string, taskId: string, type = 'agent.progress', projectId = 'project') =>
      storage!.repositories.events.append({
        id,
        projectId,
        taskId,
        type,
        actor: { type: 'system', id: 'test' },
        payload: { text: id },
        occurredAt: '2026-10-24T00:00:00.000Z',
      });
    append('first', 'target');
    for (let i = 0; i < 250; i++) append(`unrelated-${i}`, 'unrelated');
    append('link', 'target', 'task.followup.created');
    append('last', 'target');
    append('different-project', 'target', 'agent.progress', 'other-project');
    const raw = storage.sqlite.prepare('SELECT id,payload FROM events ORDER BY rowid').all();
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.sqlite.prepare('SELECT id,payload FROM events ORDER BY rowid').all()).toEqual(
      raw,
    );
    expect(storage.sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 22,
    });
    expect(
      storage.repositories.events
        .listByProject('project', { taskIds: ['target'], types: ['task.followup.created'] })
        .map((e) => e.id),
    ).toEqual(['first', 'link', 'last']);
    expect(
      storage.repositories.events
        .listByProject('project', { taskIds: [], types: ['task.followup.created'] })
        .map((e) => e.id),
    ).toEqual(['link']);
    expect(
      storage.repositories.events.listByProject('project', { taskIds: [], types: [] }),
    ).toEqual([]);
    expect(storage.repositories.events.listByProject('project')).toHaveLength(253);
    const plan = storage.sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT payload FROM events WHERE project_id = ? AND json_extract(payload, '$.taskId') IN (SELECT value FROM json_each(?))",
      )
      .all('project', '["target"]');
    expect(JSON.stringify(plan)).toContain('events_project_task_time_idx');
    append('new-progress', 'target');
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(
      storage.repositories.events
        .listByProject('project', { taskIds: ['target'], types: [] })
        .map((e) => e.id),
    ).toEqual(['first', 'link', 'last', 'new-progress']);
    expect(storage.sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  } finally {
    if (storage?.sqlite.open) storage.close();
    const target = resolve(root);
    if (!relative(resolve(tmpdir()), target).startsWith('event-selection-migration-'))
      throw Error('Unexpected fixture');
    rmSync(target, { recursive: true, force: true });
  }
});
