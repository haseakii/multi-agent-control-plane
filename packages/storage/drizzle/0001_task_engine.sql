CREATE TABLE execution_attempts (
  id text PRIMARY KEY NOT NULL,
  task_id text NOT NULL,
  assignment_id text NOT NULL,
  state text NOT NULL,
  number integer NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX execution_attempts_task_idx ON execution_attempts (task_id);
--> statement-breakpoint
CREATE INDEX execution_attempts_assignment_number_idx ON execution_attempts (assignment_id, number);
--> statement-breakpoint
CREATE INDEX execution_attempts_state_idx ON execution_attempts (state);
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN execution_attempt_id text;
--> statement-breakpoint
CREATE INDEX conversations_attempt_idx ON conversations (execution_attempt_id);
