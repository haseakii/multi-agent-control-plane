-- SQLite appends rowid to this index, supporting project-scoped cursor scans.
CREATE INDEX events_project_sequence_idx ON events(project_id);
