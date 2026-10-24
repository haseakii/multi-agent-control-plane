import {
  ContextSearchQuerySchema,
  ContextSearchHitSchema,
  type Artifact,
  type ContextSearchIndex,
  type ContextSearchQuery,
  type ContextSearchHit,
} from '@control-plane/core';
import type Database from 'better-sqlite3';

export const TEXT_INDEX_BYTES = 262144;
export const isSearchableText = (artifact: Artifact) =>
  artifact.mimeType.startsWith('text/') || artifact.mimeType.includes('json');

/** Search storage is replaceable. FTS trigram supports Chinese; short queries use substring matching. */
export class SqliteContextSearch implements ContextSearchIndex {
  constructor(private readonly sqlite: Database.Database) {}

  indexArtifact(artifact: Artifact, bytes: Uint8Array): void {
    if (!isSearchableText(artifact)) return;
    // Streaming decode avoids storing an incomplete UTF-8 sequence at the prefix boundary.
    const truncated = bytes.byteLength > TEXT_INDEX_BYTES;
    const content = new TextDecoder().decode(bytes.subarray(0, TEXT_INDEX_BYTES), {
      stream: truncated,
    });
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM context_search WHERE id = ? AND source = 'artifact'")
        .run(artifact.id);
      this.sqlite
        .prepare(
          `INSERT INTO context_search
        (id, project_id, source, kind, task_id, created_at, status, truncated, title, content)
        VALUES (?, ?, 'artifact', ?, ?, ?, 'published', ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.projectId,
          artifact.kind,
          artifact.taskId ?? null,
          artifact.createdAt,
          Number(truncated),
          artifact.kind + ' · ' + artifact.id,
          content,
        );
    })();
  }
  hasArtifact(id: string): boolean {
    return !!this.sqlite
      .prepare("SELECT 1 FROM context_search WHERE id = ? AND source = 'artifact'")
      .get(id);
  }
  search(projectId: string, raw: ContextSearchQuery): ContextSearchHit[] {
    const query = ContextSearchQuerySchema.parse(raw);
    const short = Array.from(query.query).length < 3;
    const conditions = [
      'project_id = ?',
      "(source = 'artifact' OR status = 'accepted')",
      short
        ? '(instr(lower(title), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0)'
        : 'context_search MATCH ?',
    ];
    const values: (string | number)[] = [projectId];
    if (short) values.push(query.query, query.query);
    else values.push('"' + query.query.replaceAll('"', '""') + '"');
    for (const [column, value] of [
      ['source', query.source],
      ['kind', query.kind],
      ['task_id', query.taskId],
    ] as const) {
      if (value) {
        conditions.push(column + ' = ?');
        values.push(value);
      }
    }
    if (query.since) {
      conditions.push('created_at >= ?');
      values.push(query.since);
    }
    values.push(query.limit);
    const excerpt = short
      ? 'substr(content, 1, 300)'
      : "snippet(context_search, 9, '', '', '…', 48)";
    const rows = this.sqlite
      .prepare(
        `SELECT id, source, title, kind, task_id AS taskId,
      created_at AS createdAt, ${excerpt} AS excerpt, truncated FROM context_search
      WHERE ${conditions.join(' AND ')} ORDER BY ${short ? 'created_at DESC' : 'rank, created_at DESC'} LIMIT ?`,
      )
      .all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => ContextSearchHitSchema.parse({ ...row, truncated: !!row.truncated }));
  }
}
