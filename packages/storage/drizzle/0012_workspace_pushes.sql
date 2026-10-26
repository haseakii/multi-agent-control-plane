CREATE TABLE workspace_pushes (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  review_id TEXT NOT NULL REFERENCES workspace_reviews(id),
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  state TEXT NOT NULL,
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX workspace_pushes_task_idx ON workspace_pushes(task_id);
--> statement-breakpoint
UPDATE project_policies SET payload = json_set(payload, '$.gitPush', 'deny') WHERE json_extract(payload, '$.gitPush') IS NULL;
