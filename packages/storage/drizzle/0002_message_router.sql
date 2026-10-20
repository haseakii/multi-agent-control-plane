CREATE TABLE message_deliveries (
  id text PRIMARY KEY NOT NULL,
  message_id text NOT NULL,
  project_id text NOT NULL,
  recipient_agent_id text NOT NULL,
  mailbox_key text NOT NULL,
  sequence integer NOT NULL,
  state text NOT NULL,
  attempt_count integer NOT NULL,
  available_at text NOT NULL,
  lease_until text,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX message_deliveries_recipient_state_idx
ON message_deliveries (recipient_agent_id, state, available_at);
--> statement-breakpoint
CREATE UNIQUE INDEX message_deliveries_mailbox_sequence_idx
ON message_deliveries (mailbox_key, sequence);
--> statement-breakpoint
CREATE UNIQUE INDEX message_deliveries_message_idx
ON message_deliveries (message_id);
