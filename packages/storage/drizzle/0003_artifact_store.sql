CREATE TABLE artifact_links (
  id text PRIMARY KEY NOT NULL,
  artifact_id text NOT NULL,
  project_id text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  created_at text NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX artifact_links_target_unique_idx
ON artifact_links (artifact_id, entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX artifact_links_project_idx
ON artifact_links (project_id);
--> statement-breakpoint
CREATE INDEX artifact_links_entity_idx
ON artifact_links (entity_type, entity_id);
