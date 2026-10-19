import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PotentialSecretError, openSqliteStorage } from './index.js';

const now = '2026-10-19T06:45:00Z';
const project = {
  id: 'project-storage-test',
  name: 'Storage test',
  createdAt: now,
  updatedAt: now,
} as const;

const task = {
  id: 'task-storage-test',
  projectId: project.id,
  title: 'Persist durable state',
  objective: 'Verify SQLite restart recovery',
  state: 'ready',
  dependencyIds: [],
  contextRefs: [],
  resultArtifactRefs: [],
  createdAt: now,
  updatedAt: now,
} as const;

const tempDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'control-plane-storage-'));
  tempDirectories.push(directory);
  return join(directory, 'control-plane.sqlite');
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLite storage', () => {
  it('migrates an empty database, enables WAL, and survives process-style reopen', () => {
    const filename = createDatabasePath();
    const first = openSqliteStorage({ filename });

    expect(first.getJournalMode().toLowerCase()).toBe('wal');
    first.repositories.projects.upsert(project);
    first.repositories.tasks.upsert(task);
    first.repositories.events.append({
      id: 'event-storage-test',
      projectId: project.id,
      type: 'task.created',
      actor: { type: 'system', id: 'storage-test' },
      taskId: task.id,
      payload: { source: 'migration-test' },
      occurredAt: now,
    });

    const migrationTable = first.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get();
    expect(migrationTable).toBeTruthy();
    first.close();

    const second = openSqliteStorage({ filename });
    expect(second.repositories.projects.get(project.id)?.name).toBe('Storage test');
    expect(second.repositories.tasks.get(task.id)?.state).toBe('ready');
    expect(second.repositories.events.listByProject(project.id)).toHaveLength(1);
    second.close();
  });

  it('keeps audit events append-only by rejecting duplicate event ids', () => {
    const storage = openSqliteStorage({ filename: createDatabasePath() });
    const event = {
      id: 'event-append-only',
      projectId: project.id,
      type: 'task.created',
      actor: { type: 'system', id: 'test' },
      payload: {},
      occurredAt: now,
    } as const;

    storage.repositories.events.append(event);
    expect(() => storage.repositories.events.append(event)).toThrow();
    expect(storage.repositories.events.listByProject(project.id)).toHaveLength(1);
    storage.close();
  });

  it('rejects likely secrets before task, message, or event payload persistence', () => {
    const storage = openSqliteStorage({ filename: createDatabasePath() });

    expect(() =>
      storage.repositories.tasks.upsert({
        ...task,
        objective: 'Use Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      }),
    ).toThrow(PotentialSecretError);

    expect(() =>
      storage.repositories.messages.upsert({
        id: 'message-secret',
        projectId: project.id,
        fromAgentId: 'agent-a',
        toAgentId: 'agent-b',
        type: 'request',
        content: 'review this',
        artifactRefs: [],
        metadata: { apiKey: 'should-not-be-stored' },
        createdAt: now,
      }),
    ).toThrow(PotentialSecretError);

    expect(() =>
      storage.repositories.events.append({
        id: 'event-secret',
        projectId: project.id,
        type: 'tool.failed',
        actor: { type: 'system', id: 'test' },
        payload: { access_token: 'should-not-be-stored' },
        occurredAt: now,
      }),
    ).toThrow(PotentialSecretError);

    const persisted = storage.sqlite
      .prepare('SELECT COUNT(*) AS count FROM tasks')
      .get() as { count: number };
    expect(persisted.count).toBe(0);
    storage.close();
  });
});
