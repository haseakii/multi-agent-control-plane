CREATE TABLE external_clients (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE agent_installations (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL
);
