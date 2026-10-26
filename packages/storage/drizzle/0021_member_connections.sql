UPDATE external_clients SET payload = json_set(payload, '$.revision', 1)
WHERE json_type(payload, '$.revision') IS NULL;
--> statement-breakpoint
CREATE TABLE agent_member_origins (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL
);
