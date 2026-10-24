CREATE TABLE workspace_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  state TEXT NOT NULL,
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX workspace_reviews_task_idx ON workspace_reviews(task_id);
