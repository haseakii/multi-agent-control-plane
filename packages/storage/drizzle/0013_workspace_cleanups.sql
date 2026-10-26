CREATE TABLE workspace_cleanups (
  id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  state TEXT NOT NULL,
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX workspace_cleanups_task_idx ON workspace_cleanups(task_id);
