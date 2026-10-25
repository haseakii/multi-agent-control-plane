import type Database from 'better-sqlite3';
import {
  AgentIdSchema,
  AgentSessionDefaultsSchema,
  TaskIdSchema,
  TaskSessionSettingsSchema,
  type AgentSessionDefaults,
  type SessionSettingValues,
  type TaskSessionSettings,
} from '@control-plane/core';
import { assertNoPotentialSecrets } from './secrets.js';

/** Preferences and confirmed execution settings are independent durable records. */
export interface SessionSettingsRepository {
  getDefaults(agentId: string): AgentSessionDefaults;
  saveDefaults(
    agentId: string,
    expectedRevision: number,
    values: SessionSettingValues,
  ): AgentSessionDefaults;
  getTask(taskId: string): TaskSessionSettings | undefined;
  putTask(value: unknown): TaskSessionSettings;
}

export class SessionSettingsRevisionConflictError extends Error {
  readonly code = 'SESSION_SETTINGS_REVISION_CONFLICT' as const;
  constructor() {
    super('The agent settings changed. Reload them before saving again.');
    this.name = 'SessionSettingsRevisionConflictError';
  }
}

export class SqliteSessionSettingsRepository implements SessionSettingsRepository {
  constructor(private readonly sqlite: Database.Database) {}

  getDefaults(rawAgentId: string): AgentSessionDefaults {
    const agentId = AgentIdSchema.parse(rawAgentId);
    const row = this.sqlite
      .prepare('SELECT revision, values_json FROM agent_session_defaults WHERE agent_id = ?')
      .get(agentId) as { revision: number; values_json: string } | undefined;
    const value = AgentSessionDefaultsSchema.parse({
      agentId,
      revision: row?.revision ?? 0,
      values: row ? JSON.parse(row.values_json) : {},
    });
    assertNoPotentialSecrets(value);
    return value;
  }

  saveDefaults(
    rawAgentId: string,
    expectedRevision: number,
    values: SessionSettingValues,
  ): AgentSessionDefaults {
    const expected = AgentSessionDefaultsSchema.parse({
      agentId: rawAgentId,
      revision: expectedRevision,
      values,
    });
    assertNoPotentialSecrets(expected);
    // IMMEDIATE serializes writers before reading the revision, including other connections.
    return this.sqlite
      .transaction(() => {
        if (this.getDefaults(expected.agentId).revision !== expected.revision)
          throw new SessionSettingsRevisionConflictError();
        const next = AgentSessionDefaultsSchema.parse({
          ...expected,
          revision: expected.revision + 1,
        });
        this.sqlite
          .prepare(
            `INSERT INTO agent_session_defaults (agent_id, revision, values_json)
           VALUES (?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             revision = excluded.revision, values_json = excluded.values_json`,
          )
          .run(next.agentId, next.revision, JSON.stringify(next.values));
        return next;
      })
      .immediate();
  }

  getTask(rawTaskId: string): TaskSessionSettings | undefined {
    const taskId = TaskIdSchema.parse(rawTaskId);
    const row = this.sqlite
      .prepare('SELECT payload FROM task_session_settings WHERE task_id = ?')
      .get(taskId) as { payload: string } | undefined;
    if (!row) return undefined;
    const value = TaskSessionSettingsSchema.parse(JSON.parse(row.payload));
    assertNoPotentialSecrets(value);
    if (value.taskId !== taskId)
      throw new Error('Stored task session settings identity is invalid.');
    return value;
  }

  putTask(input: unknown): TaskSessionSettings {
    const value = TaskSessionSettingsSchema.parse(input);
    assertNoPotentialSecrets(value);
    this.sqlite
      .prepare(
        `INSERT INTO task_session_settings (task_id, agent_id, state, payload)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           agent_id = excluded.agent_id, state = excluded.state, payload = excluded.payload`,
      )
      .run(value.taskId, value.agentId, value.state, JSON.stringify(value));
    return structuredClone(value);
  }
}
