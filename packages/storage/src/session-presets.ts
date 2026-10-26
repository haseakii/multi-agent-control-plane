import type Database from 'better-sqlite3';
import {
  AgentIdSchema,
  AgentSessionPresetIdSchema,
  AgentSessionPresetRevisionSchema,
  AgentSessionPresetSchema,
  CreateAgentSessionPresetSchema,
  UpdateAgentSessionPresetSchema,
  ListAgentSessionPresetsSchema,
  MAX_ACTIVE_AGENT_SESSION_PRESETS,
  MAX_TOTAL_AGENT_SESSION_PRESETS,
  type AgentSessionPreset,
} from '@control-plane/core';
import { assertNoPotentialSecrets } from './secrets.js';

export interface SessionPresetsRepository {
  list(agentId: string, options?: { includeArchived?: boolean }): AgentSessionPreset[];
  get(agentId: string, id: string): AgentSessionPreset | undefined;
  create(input: unknown): AgentSessionPreset;
  update(agentId: string, id: string, expectedRevision: number, input: unknown): AgentSessionPreset;
  archive(agentId: string, id: string, expectedRevision: number): AgentSessionPreset;
  restore(agentId: string, id: string, expectedRevision: number): AgentSessionPreset;
}

export type SessionPresetsErrorCode =
  | 'PRESET_NOT_FOUND'
  | 'PRESET_REVISION_CONFLICT'
  | 'PRESET_NAME_CONFLICT'
  | 'PRESET_LIMIT_EXCEEDED';

export class SessionPresetsError extends Error {
  constructor(
    readonly code: SessionPresetsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionPresetsError';
  }
}

type PresetRow = {
  agent_id: string;
  id: string;
  name: string;
  revision: number;
  archived: number;
  payload: string;
};

/** Named preferences remain separate from defaults and copied task execution values. */
export class SqliteSessionPresetsRepository implements SessionPresetsRepository {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private read(row: PresetRow): AgentSessionPreset {
    const value = AgentSessionPresetSchema.parse(JSON.parse(row.payload));
    assertNoPotentialSecrets(value);
    if (
      value.agentId !== row.agent_id ||
      value.id !== row.id ||
      value.name !== row.name ||
      value.revision !== row.revision ||
      Number(value.archived) !== row.archived
    )
      throw new Error('Stored session preset identity or projection is invalid.');
    return value;
  }

  list(rawAgentId: string, options: { includeArchived?: boolean } = {}): AgentSessionPreset[] {
    const agentId = AgentIdSchema.parse(rawAgentId);
    const parsed = ListAgentSessionPresetsSchema.parse(options);
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM agent_session_presets WHERE agent_id = ?
       ${parsed.includeArchived ? '' : 'AND archived = 0'} ORDER BY rowid LIMIT ?`,
      )
      .all(agentId, MAX_TOTAL_AGENT_SESSION_PRESETS) as PresetRow[];
    return rows.map((row) => this.read(row));
  }

  get(rawAgentId: string, rawId: string): AgentSessionPreset | undefined {
    const agentId = AgentIdSchema.parse(rawAgentId),
      id = AgentSessionPresetIdSchema.parse(rawId);
    const row = this.sqlite
      .prepare('SELECT * FROM agent_session_presets WHERE agent_id = ? AND id = ?')
      .get(agentId, id) as PresetRow | undefined;
    return row ? this.read(row) : undefined;
  }

  private assertName(agentId: string, name: string, exceptId?: string) {
    const existing = this.sqlite
      .prepare(
        'SELECT id FROM agent_session_presets WHERE agent_id = ? AND name = ? COLLATE NOCASE AND archived = 0 AND id <> ?',
      )
      .get(agentId, name, exceptId ?? '') as { id: string } | undefined;
    if (existing)
      throw new SessionPresetsError(
        'PRESET_NAME_CONFLICT',
        'An active preset already uses this name.',
      );
  }

  private assertActiveLimit(agentId: string) {
    const { count } = this.sqlite
      .prepare(
        'SELECT count(*) AS count FROM agent_session_presets WHERE agent_id = ? AND archived = 0',
      )
      .get(agentId) as { count: number };
    if (count >= MAX_ACTIVE_AGENT_SESSION_PRESETS)
      throw new SessionPresetsError(
        'PRESET_LIMIT_EXCEEDED',
        'This agent already has 32 active presets. Archive one before adding or restoring another.',
      );
  }

  create(input: unknown): AgentSessionPreset {
    const parsed = CreateAgentSessionPresetSchema.parse(input);
    assertNoPotentialSecrets(parsed);
    return this.sqlite
      .transaction(() => {
        if (this.get(parsed.agentId, parsed.id))
          throw new SessionPresetsError(
            'PRESET_REVISION_CONFLICT',
            'This preset identifier already exists.',
          );
        const { count } = this.sqlite
          .prepare('SELECT count(*) AS count FROM agent_session_presets WHERE agent_id = ?')
          .get(parsed.agentId) as { count: number };
        if (count >= MAX_TOTAL_AGENT_SESSION_PRESETS)
          throw new SessionPresetsError(
            'PRESET_LIMIT_EXCEEDED',
            'This agent already has 128 presets including archived presets.',
          );
        this.assertName(parsed.agentId, parsed.name);
        this.assertActiveLimit(parsed.agentId);
        const timestamp = this.clock();
        const value = AgentSessionPresetSchema.parse({
          ...parsed,
          revision: 1,
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        this.sqlite
          .prepare(
            'INSERT INTO agent_session_presets (agent_id, id, name, revision, archived, payload) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            value.agentId,
            value.id,
            value.name,
            value.revision,
            Number(value.archived),
            JSON.stringify(value),
          );
        return structuredClone(value);
      })
      .immediate();
  }

  private current(agentId: string, id: string, expectedRevision: number): AgentSessionPreset {
    AgentSessionPresetRevisionSchema.parse(expectedRevision);
    const current = this.get(agentId, id);
    if (!current)
      throw new SessionPresetsError('PRESET_NOT_FOUND', 'This agent preset is unavailable.');
    if (current.revision !== expectedRevision)
      throw new SessionPresetsError(
        'PRESET_REVISION_CONFLICT',
        'The preset changed. Reload it before saving again.',
      );
    return current;
  }

  private save(
    current: AgentSessionPreset,
    patch: Partial<Pick<AgentSessionPreset, 'name' | 'values' | 'archived'>>,
  ): AgentSessionPreset {
    const next = AgentSessionPresetSchema.parse({
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: this.clock(),
    });
    assertNoPotentialSecrets(next);
    if (!next.archived) this.assertName(next.agentId, next.name, next.id);
    const changed = this.sqlite
      .prepare(
        'UPDATE agent_session_presets SET name = ?, revision = ?, archived = ?, payload = ? WHERE agent_id = ? AND id = ? AND revision = ?',
      )
      .run(
        next.name,
        next.revision,
        Number(next.archived),
        JSON.stringify(next),
        next.agentId,
        next.id,
        current.revision,
      );
    if (changed.changes !== 1)
      throw new SessionPresetsError(
        'PRESET_REVISION_CONFLICT',
        'The preset changed. Reload it before saving again.',
      );
    return structuredClone(next);
  }

  update(
    agentId: string,
    id: string,
    expectedRevision: number,
    input: unknown,
  ): AgentSessionPreset {
    const patch = UpdateAgentSessionPresetSchema.parse(input);
    assertNoPotentialSecrets(patch);
    const changes = {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.values === undefined ? {} : { values: patch.values }),
    };
    return this.sqlite
      .transaction(() => this.save(this.current(agentId, id, expectedRevision), changes))
      .immediate();
  }

  archive(agentId: string, id: string, expectedRevision: number): AgentSessionPreset {
    return this.sqlite
      .transaction(() => {
        const current = this.current(agentId, id, expectedRevision);
        return current.archived ? current : this.save(current, { archived: true });
      })
      .immediate();
  }

  restore(agentId: string, id: string, expectedRevision: number): AgentSessionPreset {
    return this.sqlite
      .transaction(() => {
        const current = this.current(agentId, id, expectedRevision);
        if (!current.archived) return current;
        this.assertName(current.agentId, current.name, current.id);
        this.assertActiveLimit(current.agentId);
        return this.save(current, { archived: false });
      })
      .immediate();
  }
}
