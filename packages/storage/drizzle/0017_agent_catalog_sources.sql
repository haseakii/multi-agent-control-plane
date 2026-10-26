CREATE TABLE agent_catalog_sources (
  agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX agent_catalog_sources_entry_idx ON agent_catalog_sources(entry_id);
