CREATE TABLE network_settings (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'global'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  global_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE agent_network_settings (
  agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE execution_network_observations (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_attempts(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX execution_network_task_idx ON execution_network_observations(task_id);
