CREATE TABLE projects (
  id text PRIMARY KEY NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE TABLE agent_definitions (
  id text PRIMARY KEY NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE TABLE boss_assignments (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX boss_assignments_project_idx ON boss_assignments (project_id);
--> statement-breakpoint
CREATE TABLE runners (
  id text PRIMARY KEY NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE TABLE workspaces (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX workspaces_project_idx ON workspaces (project_id);
--> statement-breakpoint
CREATE TABLE tasks (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL,
  parent_task_id text,
  state text NOT NULL,
  updated_at text NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX tasks_project_state_idx ON tasks (project_id, state);
--> statement-breakpoint
CREATE INDEX tasks_parent_idx ON tasks (parent_task_id);
--> statement-breakpoint
CREATE TABLE assignments (
  id text PRIMARY KEY NOT NULL,
  task_id text NOT NULL,
  agent_id text NOT NULL,
  state text NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX assignments_task_idx ON assignments (task_id);
--> statement-breakpoint
CREATE INDEX assignments_agent_state_idx ON assignments (agent_id, state);
--> statement-breakpoint
CREATE TABLE conversations (
  id text PRIMARY KEY NOT NULL,
  task_id text NOT NULL,
  assignment_id text NOT NULL,
  agent_id text NOT NULL,
  runner_id text NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX conversations_task_idx ON conversations (task_id);
--> statement-breakpoint
CREATE INDEX conversations_assignment_idx ON conversations (assignment_id);
--> statement-breakpoint
CREATE TABLE messages (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL,
  task_id text,
  from_agent_id text NOT NULL,
  to_agent_id text,
  type text NOT NULL,
  created_at text NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX messages_project_created_idx ON messages (project_id, created_at);
--> statement-breakpoint
CREATE INDEX messages_recipient_idx ON messages (to_agent_id, created_at);
--> statement-breakpoint
CREATE TABLE artifacts (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL,
  task_id text,
  sha256 text NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX artifacts_project_idx ON artifacts (project_id);
--> statement-breakpoint
CREATE INDEX artifacts_sha256_idx ON artifacts (sha256);
--> statement-breakpoint
CREATE TABLE approvals (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL,
  task_id text,
  state text NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX approvals_project_state_idx ON approvals (project_id, state);
--> statement-breakpoint
CREATE TABLE events (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL,
  type text NOT NULL,
  occurred_at text NOT NULL,
  payload text NOT NULL
);
--> statement-breakpoint
CREATE INDEX events_project_time_idx ON events (project_id, occurred_at);
--> statement-breakpoint
CREATE INDEX events_project_type_idx ON events (project_id, type);
