CREATE TABLE agent_session_presets (
  agent_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  archived INTEGER NOT NULL CHECK(archived IN (0, 1)),
  payload TEXT NOT NULL,
  PRIMARY KEY (agent_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_session_presets_active_name_idx
ON agent_session_presets (agent_id, name COLLATE NOCASE) WHERE archived = 0;
