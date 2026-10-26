CREATE TABLE input_attachments (
  id TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  content BLOB NOT NULL
);
--> statement-breakpoint
CREATE TABLE input_attachment_messages (
  owner_id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ids_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX input_attachment_messages_task ON input_attachment_messages(task_id);
