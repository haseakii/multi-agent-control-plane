CREATE TABLE agent_session_defaults (
  agent_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  values_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE task_session_settings (
  task_id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('requested', 'applied', 'failed')),
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX task_session_settings_agent_idx ON task_session_settings(agent_id);
