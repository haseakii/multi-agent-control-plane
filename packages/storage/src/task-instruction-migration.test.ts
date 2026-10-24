import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  openSqliteStorage,
  createConsistentSqliteSnapshot,
  inspectSqliteSnapshot,
} from './index.js';

it('upgrades a real seven-migration database, preserves task history and persists task instructions after reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'instruction-migration-'));
  let storage: ReturnType<typeof openSqliteStorage> | undefined;
  try {
    const folder = join(root, 'old');
    mkdirSync(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    journal.entries = journal.entries.slice(0, 7);
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
      name: 'Previous project',
      createdAt: at,
      updatedAt: at,
    });
    storage.repositories.tasks.upsert({
      id: 't',
      projectId: 'p',
      title: 'Old task',
      objective: 'Preserve',
      state: 'waiting',
      dependencyIds: [],
      contextRefs: [],
      resultArtifactRefs: [],
      createdAt: at,
      updatedAt: at,
    });
    storage.repositories.events.append({
      id: 'event',
      projectId: 'p',
      taskId: 't',
      actor: { type: 'system', id: 'test' },
      type: 'previous.history',
      payload: { keep: true },
      occurredAt: at,
    });
    const original = storage.sqlite.prepare('SELECT payload FROM tasks').all(),
      events = storage.sqlite.prepare('SELECT payload FROM events').all();
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(
      storage.sqlite.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get(),
    ).toEqual({ count: 15 });
    expect(storage.sqlite.prepare('SELECT payload FROM tasks').all()).toEqual(original);
    expect(storage.sqlite.prepare('SELECT payload FROM events').all()).toEqual(events);
    storage.repositories.taskInstructions.upsert({
      formatVersion: 1,
      id: 'instruction-test',
      projectId: 'p',
      taskId: 't',
      actor: { type: 'user', id: 'local-operator' },
      content: 'Durable input',
      idempotencyKeyHash: 'a'.repeat(64),
      state: 'queued',
      createdAt: at,
      updatedAt: at,
    });
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.repositories.taskInstructions.get('instruction-test')?.content).toBe(
      'Durable input',
    );
    const oldInstruction = storage.repositories.taskInstructions.get('instruction-test')!;
    storage.repositories.taskInstructions.upsert({
      ...oldInstruction,
      id: 'instruction-client',
      actor: { type: 'agent', id: 'mcp-client:codex' },
    });
    storage.close();
    storage = openSqliteStorage({ filename });
    expect(storage.repositories.taskInstructions.get('instruction-test')?.actor).toEqual({
      type: 'user',
      id: 'local-operator',
    });
    expect(storage.repositories.taskInstructions.get('instruction-client')?.actor).toEqual({
      type: 'agent',
      id: 'mcp-client:codex',
    });
    expect(storage.sqlite.pragma('foreign_key_check')).toEqual([]);
    storage.close();
    await createConsistentSqliteSnapshot(filename, join(root, 'snapshot.sqlite'));
    expect(inspectSqliteSnapshot(join(root, 'snapshot.sqlite')).migrations).toHaveLength(15);
    storage = openSqliteStorage({ filename: join(root, 'snapshot.sqlite') });
    expect(storage.repositories.taskInstructions.get('instruction-test')?.content).toBe(
      'Durable input',
    );
  } finally {
    if (storage?.sqlite.open) storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
