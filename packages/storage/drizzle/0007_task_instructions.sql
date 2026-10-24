CREATE TABLE task_instructions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  state TEXT NOT NULL CHECK (state IN ('queued','claimed','delivered')),
  owner_attempt_id TEXT REFERENCES execution_attempts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX task_instructions_task_state_idx ON task_instructions(task_id, state);
