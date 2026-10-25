import type Database from 'better-sqlite3';
import {
  AgentIdSchema,
  ExecutionAttemptIdSchema,
  GlobalNetworkChoiceSchema,
  AgentNetworkChoiceSchema,
  NetworkSettingsInputSchema,
  NetworkSettingsSchema,
  ExecutionNetworkObservationSchema,
  type NetworkSettings,
  type ExecutionNetworkObservation,
} from '@control-plane/core';
import { assertNoPotentialSecrets } from './secrets.js';

export interface NetworkSettingsRepository {
  read(): NetworkSettings;
  save(expectedRevision: number, input: unknown): NetworkSettings;
  getAttempt(attemptId: string): ExecutionNetworkObservation | undefined;
  putAttempt(input: unknown): ExecutionNetworkObservation;
}
export class NetworkSettingsConflictError extends Error {
  readonly code = 'NETWORK_SETTINGS_CHANGED';
  constructor() {
    super('Network settings changed; reload before saving.');
  }
}
export class SqliteNetworkSettingsRepository implements NetworkSettingsRepository {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly now = () => new Date().toISOString(),
  ) {}
  read(): NetworkSettings {
    const row = this.sqlite
      .prepare("SELECT revision,global_json,updated_at FROM network_settings WHERE id='global'")
      .get() as { revision: number; global_json: string; updated_at: string } | undefined;
    const members = Object.fromEntries(
      (
        this.sqlite.prepare('SELECT agent_id,payload FROM agent_network_settings').all() as {
          agent_id: string;
          payload: string;
        }[]
      ).map((v) => [
        AgentIdSchema.parse(v.agent_id),
        AgentNetworkChoiceSchema.parse(JSON.parse(v.payload)),
      ]),
    );
    const value = NetworkSettingsSchema.parse({
      revision: row?.revision ?? 0,
      updatedAt: row?.updated_at ?? null,
      global: row
        ? GlobalNetworkChoiceSchema.parse(JSON.parse(row.global_json))
        : { mode: 'unmanaged', bypass: [] },
      members,
    });
    assertNoPotentialSecrets(value);
    return value;
  }
  save(expectedRevision: number, input: unknown): NetworkSettings {
    NetworkSettingsSchema.shape.revision.parse(expectedRevision);
    const parsed = NetworkSettingsInputSchema.parse(input);
    assertNoPotentialSecrets(parsed);
    return this.sqlite
      .transaction(() => {
        if (this.read().revision !== expectedRevision) throw new NetworkSettingsConflictError();
        this.sqlite
          .prepare(
            "INSERT INTO network_settings(id,revision,global_json,updated_at) VALUES('global',?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,global_json=excluded.global_json,updated_at=excluded.updated_at",
          )
          .run(expectedRevision + 1, JSON.stringify(parsed.global), this.now());
        this.sqlite.prepare('DELETE FROM agent_network_settings').run();
        const insert = this.sqlite.prepare(
          'INSERT INTO agent_network_settings(agent_id,payload) VALUES(?,?)',
        );
        for (const [agentId, choice] of Object.entries(parsed.members))
          insert.run(agentId, JSON.stringify(choice));
        return this.read();
      })
      .immediate();
  }
  getAttempt(rawId: string): ExecutionNetworkObservation | undefined {
    const id = ExecutionAttemptIdSchema.parse(rawId);
    const row = this.sqlite
      .prepare('SELECT task_id,payload FROM execution_network_observations WHERE attempt_id=?')
      .get(id) as { task_id: string; payload: string } | undefined;
    if (!row) return;
    const value = ExecutionNetworkObservationSchema.parse(JSON.parse(row.payload));
    assertNoPotentialSecrets(value);
    if (value.attemptId !== id || value.taskId !== row.task_id)
      throw Error('Invalid stored network observation identity.');
    return value;
  }
  putAttempt(raw: unknown): ExecutionNetworkObservation {
    const value = ExecutionNetworkObservationSchema.parse(raw);
    assertNoPotentialSecrets(value);
    const existing = this.getAttempt(value.attemptId);
    if (
      existing &&
      JSON.stringify({ ...existing, state: value.state, observedAt: value.observedAt }) !==
        JSON.stringify(value)
    )
      throw Error('An attempt network context cannot be replaced.');
    if (existing?.state === 'started' && value.state !== 'started')
      throw Error('Started network context cannot return to prepared.');
    this.sqlite
      .prepare(
        'INSERT INTO execution_network_observations(attempt_id,task_id,payload) VALUES(?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET payload=excluded.payload',
      )
      .run(value.attemptId, value.taskId, JSON.stringify(value));
    return structuredClone(value);
  }
}
