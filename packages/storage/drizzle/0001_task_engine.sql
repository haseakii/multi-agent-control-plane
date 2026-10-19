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
INSERT INTO execution_attempts (id, task_id, assignment_id, state, number, payload)
SELECT
  conversations.id,
  conversations.task_id,
  conversations.assignment_id,
  'interrupted',
  ROW_NUMBER() OVER (
    PARTITION BY conversations.assignment_id
    ORDER BY json_extract(conversations.payload, '$.createdAt'), conversations.id
  ),
  json_object(
    'id', conversations.id,
    'taskId', conversations.task_id,
    'assignmentId', conversations.assignment_id,
    'number', ROW_NUMBER() OVER (
      PARTITION BY conversations.assignment_id
      ORDER BY json_extract(conversations.payload, '$.createdAt'), conversations.id
    ),
    'state', 'interrupted',
    'runnerId', json_extract(conversations.payload, '$.runnerId'),
    'createdAt', json_extract(conversations.payload, '$.createdAt'),
    'updatedAt', json_extract(conversations.payload, '$.createdAt'),
    'finishedAt', json_extract(conversations.payload, '$.createdAt'),
    'failure', json(json_object(
      'code', 'LEGACY_CONVERSATION_MIGRATION',
      'message', 'Conversation predates execution-attempt tracking.',
      'retryable', json('true')
    ))
  )
FROM conversations;
--> statement-breakpoint
UPDATE conversations
SET execution_attempt_id = id,
    payload = json_set(payload, '$.executionAttemptId', id);
--> statement-breakpoint
UPDATE assignments
SET state = 'waiting',
    payload = json_set(payload, '$.state', 'waiting')
WHERE state = 'running'
  AND id IN (SELECT assignment_id FROM conversations);
--> statement-breakpoint
UPDATE tasks
SET state = 'waiting',
    payload = json_set(payload, '$.state', 'waiting')
WHERE state = 'running'
  AND id IN (SELECT task_id FROM conversations);
--> statement-breakpoint
CREATE INDEX conversations_attempt_idx ON conversations (execution_attempt_id);
