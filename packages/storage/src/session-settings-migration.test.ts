import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  openSqliteStorage,
  SessionSettingsRevisionConflictError,
  SqliteSessionSettingsRepository,
} from './index.js';

function withDatabase(run: (filename: string, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'session-settings-migration-'));
  try {
    run(join(root, 'state.sqlite'), root);
  } finally {
    const target = resolve(root);
    if (!relative(resolve(tmpdir()), target).startsWith('session-settings-migration-'))
      throw new Error('Unexpected fixture directory.');
    rmSync(target, { recursive: true, force: true });
  }
}

const confirmed = {
  source: 'config-options',
  options: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'test-model',
      options: [{ value: 'test-model', name: 'Test model' }],
    },
  ],
} as const;

describe('durable agent session settings', () => {
  it('upgrades fifteen migrations without changing history and reopens defaults and execution settings', () =>
    withDatabase((filename, root) => {
      const folder = join(root, 'old');
      mkdirSync(join(folder, 'meta'), { recursive: true });
      const journal = JSON.parse(
        readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
      );
      journal.entries = journal.entries.slice(0, 15);
      writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries)
        copyFileSync(
          new URL('../drizzle/' + entry.tag + '.sql', import.meta.url),
          join(folder, entry.tag + '.sql'),
        );
      let storage = openSqliteStorage({ filename, migrationsFolder: folder });
      try {
        const at = '2026-10-25T00:00:00Z';
        storage.repositories.projects.upsert({
          id: 'project',
          name: 'Preserved project',
          createdAt: at,
          updatedAt: at,
        });
        storage.repositories.tasks.upsert({
          id: 'task',
          projectId: 'project',
          title: 'Preserved task',
          objective: 'Preserve context and edits',
          state: 'waiting',
          dependencyIds: [],
          contextRefs: [],
          resultArtifactRefs: [],
          createdAt: at,
          updatedAt: at,
        });
        storage.repositories.events.append({
          id: 'event',
          projectId: 'project',
          taskId: 'task',
          actor: { type: 'system', id: 'test' },
          type: 'previous.history',
          payload: { keep: true },
          occurredAt: at,
        });
        const tasks = storage.sqlite.prepare('SELECT * FROM tasks').all();
        const events = storage.sqlite.prepare('SELECT * FROM events').all();
        storage.close();
        storage = openSqliteStorage({ filename });
        let settings = new SqliteSessionSettingsRepository(storage.sqlite);
        expect(storage.sqlite.prepare('SELECT * FROM tasks').all()).toEqual(tasks);
        expect(storage.sqlite.prepare('SELECT * FROM events').all()).toEqual(events);
        expect(
          storage.sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get(),
        ).toEqual({
          n: 16,
        });
        expect(settings.getDefaults('agent')).toEqual({
          agentId: 'agent',
          revision: 0,
          values: {},
        });
        expect(settings.getTask('task')).toBeUndefined();
        const defaults = settings.saveDefaults('agent', 0, { model: 'test-model' });
        settings.putTask({
          taskId: 'task',
          agentId: 'agent',
          requested: { model: 'test-model' },
          state: 'requested',
        });
        const execution = settings.putTask({
          taskId: 'task',
          agentId: 'agent',
          requested: { model: 'test-model' },
          state: 'applied',
          confirmed,
          attemptId: 'attempt-one',
        });
        // Updating future-task preferences must not rewrite an existing task's applied settings.
        const futureDefaults = settings.saveDefaults('agent', defaults.revision, {
          model: 'next-model',
        });
        storage.close();
        storage = openSqliteStorage({ filename });
        settings = new SqliteSessionSettingsRepository(storage.sqlite);
        expect(settings.getDefaults('agent')).toEqual(futureDefaults);
        expect(settings.getTask('task')).toEqual(execution);
        expect(storage.repositories.tasks.get('task')?.objective).toBe(
          'Preserve context and edits',
        );
        expect(storage.sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        expect(storage.sqlite.pragma('foreign_key_check')).toEqual([]);
      } finally {
        if (storage.sqlite.open) storage.close();
      }
    }));

  it('rejects stale saves from another connection without overwriting the current defaults', () =>
    withDatabase((filename) => {
      const first = openSqliteStorage({ filename });
      const second = openSqliteStorage({ filename });
      try {
        const a = new SqliteSessionSettingsRepository(first.sqlite);
        const b = new SqliteSessionSettingsRepository(second.sqlite);
        expect(a.getDefaults('agent').revision).toBe(0);
        expect(b.getDefaults('agent').revision).toBe(0);
        a.saveDefaults('agent', 0, { model: 'first-model' });
        expect(() => b.saveDefaults('agent', 0, { model: 'stale-model' })).toThrow(
          SessionSettingsRevisionConflictError,
        );
        expect(b.getDefaults('agent').values).toEqual({ model: 'first-model' });
        b.saveDefaults('agent', 1, { model: 'second-model', reasoning_effort: 'high' });
        expect(() => a.saveDefaults('agent', 1, {})).toThrow(SessionSettingsRevisionConflictError);
        expect(a.getDefaults('agent')).toEqual({
          agentId: 'agent',
          revision: 2,
          values: { model: 'second-model', reasoning_effort: 'high' },
        });
      } finally {
        first.close();
        second.close();
      }
    }));

  it('validates and guards writes and persisted reads, while retaining failed application details', () =>
    withDatabase((filename) => {
      const storage = openSqliteStorage({ filename });
      try {
        const settings = new SqliteSessionSettingsRepository(storage.sqlite);
        expect(() => settings.saveDefaults('agent', -1, {})).toThrow();
        expect(() =>
          settings.saveDefaults('agent', 0, { access_token: 'private-value' }),
        ).toThrow();
        expect(() =>
          settings.saveDefaults('agent', 0, { model: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' }),
        ).toThrow();
        expect(() =>
          settings.putTask({
            taskId: 'task',
            agentId: 'agent',
            requested: {},
            state: 'failed',
            error: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
          }),
        ).toThrow();
        expect(() =>
          settings.putTask({ taskId: 'task', agentId: 'agent', requested: {}, state: 'complete' }),
        ).toThrow();
        expect(() =>
          settings.putTask({
            taskId: 'task',
            agentId: 'agent',
            requested: {},
            state: 'requested',
            providerConfiguration: {},
          }),
        ).toThrow();
        expect(settings.getDefaults('agent').revision).toBe(0);
        expect(settings.getTask('task')).toBeUndefined();
        const failed = settings.putTask({
          taskId: 'task',
          agentId: 'agent',
          requested: { model: 'test-model' },
          state: 'failed',
          error: 'The agent rejected this model.',
          attemptId: 'attempt-failed',
        });
        expect(settings.getTask('task')).toEqual(failed);
        settings.saveDefaults('agent', 0, { model: 'test-model' });
        storage.sqlite
          .prepare('UPDATE agent_session_defaults SET values_json = ? WHERE agent_id = ?')
          .run(JSON.stringify({ access_token: 'unsafe-old-value' }), 'agent');
        expect(() => settings.getDefaults('agent')).toThrow();
        storage.sqlite
          .prepare('UPDATE task_session_settings SET payload = ? WHERE task_id = ?')
          .run(JSON.stringify({ ...failed, requested: { password: 'unsafe-old-value' } }), 'task');
        expect(() => settings.getTask('task')).toThrow();
      } finally {
        storage.close();
      }
    }));
});
