import type Database from 'better-sqlite3';
import {
  ProjectIdSchema,
  ProjectEventNoticeSchema,
  ProjectEventReadSchema,
  type ProjectEventReader,
  type ProjectEventRead,
  type ProjectEventPage,
} from '@control-plane/core';

/** Indexed append order avoids losing late events when timestamps move backwards. */
export class SqliteProjectEventReader implements ProjectEventReader {
  constructor(private readonly sqlite: Database.Database) {}

  latest(projectId: string) {
    const row = this.sqlite
      .prepare('SELECT id FROM events WHERE project_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(ProjectIdSchema.parse(projectId)) as { id: string } | undefined;
    return row ? ProjectEventNoticeSchema.shape.id.parse(row.id) : undefined;
  }

  readAfter(projectIdInput: string, input: ProjectEventRead): ProjectEventPage {
    const projectId = ProjectIdSchema.parse(projectIdInput);
    const { after, limit } = ProjectEventReadSchema.parse(input);
    // Resolve the cursor and page in one snapshot, including reset after pruning.
    return this.sqlite.transaction((): ProjectEventPage => {
      let sequence = 0;
      if (after !== undefined) {
        const cursor = this.sqlite
          .prepare('SELECT rowid AS sequence FROM events WHERE id = ? AND project_id = ?')
          .get(after, projectId) as { sequence: number } | undefined;
        if (!cursor) {
          const latest = this.latest(projectId);
          return { status: 'reset', ...(latest === undefined ? {} : { cursor: latest }) };
        }
        sequence = cursor.sequence;
      }
      const rows = this.sqlite
        .prepare(
          `SELECT id, project_id AS projectId, type, occurred_at AS occurredAt,
          json_extract(payload, '$.taskId') AS taskId
         FROM events WHERE project_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .all(projectId, sequence, limit) as Array<Record<string, unknown>>;
      return {
        status: 'events',
        events: rows.map((row) =>
          ProjectEventNoticeSchema.parse({
            ...row,
            taskId: row.taskId ?? undefined,
          }),
        ),
      };
    })();
  }
}
