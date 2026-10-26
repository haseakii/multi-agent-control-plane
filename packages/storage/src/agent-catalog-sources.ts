import type Database from 'better-sqlite3';
import {
  AgentIdSchema,
  AgentSessionDefaultsSchema,
  AgentCatalogSourceInputSchema,
  AgentCatalogSourceSchema,
  type AgentCatalogSourceInput,
  type AgentCatalogSource,
} from '@control-plane/core';
import { assertNoPotentialSecrets } from './secrets.js';

export interface AgentCatalogSourcesRepository {
  get(agentId: string): AgentCatalogSource | undefined;
  save(
    agentId: string,
    expectedRevision: number,
    source: AgentCatalogSourceInput,
    runtimeFingerprint: string,
    observedAt: string,
  ): AgentCatalogSource;
}
export class AgentCatalogSourceConflictError extends Error {
  readonly code = 'AGENT_CATALOG_SOURCE_CHANGED';
  constructor() {
    super('The catalog association changed. Reload before saving.');
  }
}

export class SqliteAgentCatalogSourcesRepository implements AgentCatalogSourcesRepository {
  constructor(private readonly sqlite: Database.Database) {}
  get(rawAgentId: string) {
    const agentId = AgentIdSchema.parse(rawAgentId);
    const row = this.sqlite
      .prepare('SELECT entry_id,revision,payload FROM agent_catalog_sources WHERE agent_id = ?')
      .get(agentId) as { entry_id: string; revision: number; payload: string } | undefined;
    if (!row) return undefined;
    const value = AgentCatalogSourceSchema.parse(JSON.parse(row.payload));
    assertNoPotentialSecrets(value);
    if (
      value.agentId !== agentId ||
      value.entryId !== row.entry_id ||
      value.revision !== row.revision
    )
      throw new Error('Catalog association identity is invalid.');
    return value;
  }
  save(
    rawAgentId: string,
    rawRevision: number,
    rawSource: AgentCatalogSourceInput,
    runtimeFingerprint: string,
    observedAt: string,
  ) {
    const agentId = AgentIdSchema.parse(rawAgentId);
    const expectedRevision = AgentSessionDefaultsSchema.shape.revision.parse(rawRevision);
    const source = AgentCatalogSourceInputSchema.parse(rawSource);
    assertNoPotentialSecrets(source);
    return this.sqlite
      .transaction(() => {
        const previous = this.get(agentId);
        if ((previous?.revision ?? 0) !== expectedRevision)
          throw new AgentCatalogSourceConflictError();
        const value = AgentCatalogSourceSchema.parse({
          ...source,
          agentId,
          revision: expectedRevision + 1,
          runtimeFingerprint,
          createdAt: previous?.createdAt ?? observedAt,
          updatedAt: observedAt,
        });
        assertNoPotentialSecrets(value);
        this.sqlite
          .prepare(
            `INSERT INTO agent_catalog_sources(agent_id,entry_id,revision,payload) VALUES(?,?,?,?)
        ON CONFLICT(agent_id) DO UPDATE SET entry_id=excluded.entry_id,revision=excluded.revision,payload=excluded.payload`,
          )
          .run(agentId, value.entryId, value.revision, JSON.stringify(value));
        return value;
      })
      .immediate();
  }
}
