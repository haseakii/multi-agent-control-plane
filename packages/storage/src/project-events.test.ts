import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { openSqliteStorage, type SqliteStorage } from './database.js';
import { SqliteProjectEventReader } from './project-events.js';

const databases: SqliteStorage[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.sqlite.open) db.close();
});
function fixture() {
  const storage = openSqliteStorage({ filename: ':memory:' });
  databases.push(storage);
  return { storage, reader: new SqliteProjectEventReader(storage.sqlite) };
}
function append(
  storage: SqliteStorage,
  id: string,
  projectId = 'p',
  occurredAt = '2026-10-27T00:00:00Z',
) {
  return storage.repositories.events.append({
    id,
    projectId,
    occurredAt,
    type: 'test.notice',
    taskId: 'task',
    actor: { type: 'system', id: 'test' },
    payload: { content: 'private audit content' },
  });
}

it('pages by append order with a hard limit and no full audit payloads', () => {
  const { storage, reader } = fixture();
  storage.sqlite.transaction(() => {
    for (let i = 0; i < 253; i++) {
      append(storage, 'event-' + i, 'p', i % 2 ? '2020-01-01T00:00:00Z' : '2027-01-01T00:00:00Z');
      append(storage, 'other-' + i, 'other');
    }
  })();
  expect(reader.latest('p')).toBe('event-252');
  const ids: string[] = [];
  let after: string | undefined;
  for (const count of [100, 100, 53, 0]) {
    const page = reader.readAfter('p', after === undefined ? {} : { after });
    expect(page.status).toBe('events');
    if (page.status !== 'events') throw Error('Unexpected reset');
    expect(page.events).toHaveLength(count);
    expect(JSON.stringify(page)).not.toContain('private audit content');
    for (const notice of page.events) {
      expect(Object.keys(notice).sort()).toEqual([
        'id',
        'occurredAt',
        'projectId',
        'taskId',
        'type',
      ]);
      expect(notice.projectId).toBe('p');
      ids.push(notice.id);
    }
    after = page.events.at(-1)?.id ?? after;
  }
  expect(ids).toEqual(Array.from({ length: 253 }, (_, i) => 'event-' + i));
  const prepare = vi.spyOn(storage.sqlite, 'prepare');
  reader.readAfter('p', { after: 'event-200', limit: 10 });
  const sql = prepare.mock.calls
    .map(([query]) => query)
    .find((query) => query.includes('rowid > ?'))!;
  prepare.mockRestore();
  expect(sql).not.toMatch(/SELECT\s+payload/i);
  const plan = JSON.stringify(
    storage.sqlite.prepare('EXPLAIN QUERY PLAN ' + sql).all('p', 200, 10),
  );
  expect(plan).toContain('events_project_sequence_idx');
  expect(plan).not.toContain('TEMP B-TREE');
  expect(plan).not.toContain('SCAN events');
});

it('resets foreign, missing or deleted cursors to the project tail without leaking another project', () => {
  const { storage, reader } = fixture();
  append(storage, 'first');
  append(storage, 'latest');
  append(storage, 'foreign', 'other');
  for (const after of ['foreign', 'missing']) {
    expect(reader.readAfter('p', { after })).toEqual({ status: 'reset', cursor: 'latest' });
  }
  storage.sqlite.prepare('DELETE FROM events WHERE id = ?').run('first');
  expect(reader.readAfter('p', { after: 'first' })).toEqual({ status: 'reset', cursor: 'latest' });
  expect(reader.latest('empty')).toBeUndefined();
  expect(reader.readAfter('empty', { after: 'foreign' })).toEqual({ status: 'reset' });
  expect(reader.readAfter('empty', {})).toEqual({ status: 'events', events: [] });
  append(storage, 'new', 'empty');
  expect(reader.readAfter('empty', {})).toMatchObject({
    status: 'events',
    events: [{ id: 'new' }],
  });
});

it('rejects invalid page bounds and query shapes before touching storage', () => {
  const { storage, reader } = fixture();
  const prepare = vi.spyOn(storage.sqlite, 'prepare');
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity])
    expect(() => reader.readAfter('p', { limit })).toThrow();
  expect(() => reader.readAfter('', {})).toThrow();
  expect(() => reader.readAfter('p', { after: '' })).toThrow();
  expect(() => reader.readAfter('p', { after: 'x'.repeat(1025) })).toThrow();
  expect(prepare).not.toHaveBeenCalled();
});

it('upgrades the previous release database without changing audit bytes or cursor positions', () => {
  const root = mkdtempSync(join(tmpdir(), 'event-feed-upgrade-'));
  let storage: SqliteStorage | undefined;
  try {
    const folder = join(root, 'old');
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 22);
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(
        new URL('../drizzle/' + entry.tag + '.sql', import.meta.url),
        join(folder, entry.tag + '.sql'),
      );
    const filename = join(root, 'state.sqlite');
    storage = openSqliteStorage({ filename, migrationsFolder: folder });
    append(storage, 'before');
    append(storage, 'late', 'p', '2020-01-01T00:00:00Z');
    const before = storage.sqlite
      .prepare('SELECT rowid,id,payload FROM events ORDER BY rowid')
      .all();
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(
      storage.sqlite.prepare('SELECT rowid,id,payload FROM events ORDER BY rowid').all(),
    ).toEqual(before);
    expect(storage.sqlite.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 23,
    });
    expect(
      new SqliteProjectEventReader(storage.sqlite).readAfter('p', { after: 'before' }),
    ).toMatchObject({ status: 'events', events: [{ id: 'late' }] });
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(new SqliteProjectEventReader(storage.sqlite).latest('p')).toBe('late');
    expect(storage.sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(
      storage.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='events_project_sequence_idx'",
        )
        .all(),
    ).toHaveLength(1);
  } finally {
    if (storage?.sqlite.open) storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
