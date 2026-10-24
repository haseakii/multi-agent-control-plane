import { ArtifactSchema } from '@control-plane/core';
import type { Artifact } from '@control-plane/core';
import type { SqliteStorage } from '@control-plane/storage';
import { SqliteContextSearch } from '@control-plane/storage';
import { ArtifactLinkSchema, type ArtifactLink, type ArtifactMetadataStore } from './types.js';

export class SqliteArtifactMetadataStore implements ArtifactMetadataStore {
  constructor(private readonly storage: SqliteStorage) {}

  transaction<T>(operation: () => T): T {
    return this.storage.repositories.transaction(operation);
  }

  saveArtifact(artifact: Artifact): Artifact {
    return this.storage.repositories.artifacts.upsert(artifact);
  }

  indexText(artifact: Artifact, content: Uint8Array): void {
    new SqliteContextSearch(this.storage.sqlite).indexArtifact(artifact, content);
  }

  getArtifact(id: string): Artifact | undefined {
    const artifact = this.storage.repositories.artifacts.get(id);
    return artifact ? ArtifactSchema.parse(artifact) : undefined;
  }

  upsertLink(link: ArtifactLink): ArtifactLink {
    const parsed = ArtifactLinkSchema.parse(link);
    this.storage.sqlite
      .prepare(
        `INSERT OR IGNORE INTO artifact_links (
           id, artifact_id, project_id, entity_type, entity_id, created_at, payload
         ) VALUES (
           @id, @artifactId, @projectId, @entityType, @entityId, @createdAt, @payload
         )`,
      )
      .run({
        ...parsed,
        payload: JSON.stringify(parsed),
      });

    const row = this.storage.sqlite
      .prepare(
        `SELECT payload
         FROM artifact_links
         WHERE artifact_id = ? AND entity_type = ? AND entity_id = ?
         LIMIT 1`,
      )
      .get(parsed.artifactId, parsed.entityType, parsed.entityId) as
      | { payload: string }
      | undefined;
    if (!row) {
      throw new Error('Artifact link was not persisted.');
    }
    return ArtifactLinkSchema.parse(JSON.parse(row.payload));
  }

  listLinks(artifactId: string): ArtifactLink[] {
    const rows = this.storage.sqlite
      .prepare(
        `SELECT payload
         FROM artifact_links
         WHERE artifact_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(artifactId) as Array<{ payload: string }>;
    return rows.map((row) => ArtifactLinkSchema.parse(JSON.parse(row.payload)));
  }
}
