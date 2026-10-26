CREATE TABLE project_memory (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL,
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX project_memory_project_status_idx ON project_memory(project_id, status);
--> statement-breakpoint
CREATE VIRTUAL TABLE context_search USING fts5(
  id UNINDEXED, project_id UNINDEXED, source UNINDEXED, kind UNINDEXED,
  task_id UNINDEXED, created_at UNINDEXED, status UNINDEXED, truncated UNINDEXED,
  title, content, tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER project_memory_insert AFTER INSERT ON project_memory BEGIN
  INSERT INTO context_search(id, project_id, source, kind, task_id, created_at, status, truncated, title, content)
  VALUES (new.id, new.project_id, 'memory', json_extract(new.payload, '$.kind'),
    json_extract(new.payload, '$.sourceTaskId'), json_extract(new.payload, '$.createdAt'),
    new.status, 0, json_extract(new.payload, '$.title'), json_extract(new.payload, '$.content'));
END;
--> statement-breakpoint
CREATE TRIGGER project_memory_update AFTER UPDATE ON project_memory BEGIN
  DELETE FROM context_search WHERE id = old.id AND source = 'memory';
  INSERT INTO context_search(id, project_id, source, kind, task_id, created_at, status, truncated, title, content)
  VALUES (new.id, new.project_id, 'memory', json_extract(new.payload, '$.kind'),
    json_extract(new.payload, '$.sourceTaskId'), json_extract(new.payload, '$.createdAt'),
    new.status, 0, json_extract(new.payload, '$.title'), json_extract(new.payload, '$.content'));
END;
--> statement-breakpoint
CREATE TRIGGER project_memory_delete AFTER DELETE ON project_memory BEGIN
  DELETE FROM context_search WHERE id = old.id AND source = 'memory';
END;
--> statement-breakpoint
CREATE TRIGGER artifact_search_delete AFTER DELETE ON artifacts BEGIN
  DELETE FROM context_search WHERE id = old.id AND source = 'artifact';
END;
