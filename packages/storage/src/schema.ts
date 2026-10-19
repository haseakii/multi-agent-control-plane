import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const payload = () => text('payload').notNull();

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  payload: payload(),
});

export const agentDefinitions = sqliteTable('agent_definitions', {
  id: text('id').primaryKey(),
  payload: payload(),
});

export const bossAssignments = sqliteTable(
  'boss_assignments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    payload: payload(),
  },
  (table) => [index('boss_assignments_project_idx').on(table.projectId)],
);

export const runners = sqliteTable('runners', {
  id: text('id').primaryKey(),
  payload: payload(),
});

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    payload: payload(),
  },
  (table) => [index('workspaces_project_idx').on(table.projectId)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    parentTaskId: text('parent_task_id'),
    state: text('state').notNull(),
    updatedAt: text('updated_at').notNull(),
    payload: payload(),
  },
  (table) => [
    index('tasks_project_state_idx').on(table.projectId, table.state),
    index('tasks_parent_idx').on(table.parentTaskId),
  ],
);

export const assignments = sqliteTable(
  'assignments',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    agentId: text('agent_id').notNull(),
    state: text('state').notNull(),
    payload: payload(),
  },
  (table) => [
    index('assignments_task_idx').on(table.taskId),
    index('assignments_agent_state_idx').on(table.agentId, table.state),
  ],
);

export const executionAttempts = sqliteTable(
  'execution_attempts',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    assignmentId: text('assignment_id').notNull(),
    state: text('state').notNull(),
    number: integer('number').notNull(),
    payload: payload(),
  },
  (table) => [
    index('execution_attempts_task_idx').on(table.taskId),
    index('execution_attempts_assignment_number_idx').on(table.assignmentId, table.number),
    index('execution_attempts_state_idx').on(table.state),
  ],
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    assignmentId: text('assignment_id').notNull(),
    executionAttemptId: text('execution_attempt_id'),
    agentId: text('agent_id').notNull(),
    runnerId: text('runner_id').notNull(),
    payload: payload(),
  },
  (table) => [
    index('conversations_task_idx').on(table.taskId),
    index('conversations_assignment_idx').on(table.assignmentId),
    index('conversations_attempt_idx').on(table.executionAttemptId),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    taskId: text('task_id'),
    fromAgentId: text('from_agent_id').notNull(),
    toAgentId: text('to_agent_id'),
    type: text('type').notNull(),
    createdAt: text('created_at').notNull(),
    payload: payload(),
  },
  (table) => [
    index('messages_project_created_idx').on(table.projectId, table.createdAt),
    index('messages_recipient_idx').on(table.toAgentId, table.createdAt),
  ],
);

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    taskId: text('task_id'),
    sha256: text('sha256').notNull(),
    payload: payload(),
  },
  (table) => [
    index('artifacts_project_idx').on(table.projectId),
    index('artifacts_sha256_idx').on(table.sha256),
  ],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    taskId: text('task_id'),
    state: text('state').notNull(),
    payload: payload(),
  },
  (table) => [index('approvals_project_state_idx').on(table.projectId, table.state)],
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    type: text('type').notNull(),
    occurredAt: text('occurred_at').notNull(),
    payload: payload(),
  },
  (table) => [
    index('events_project_time_idx').on(table.projectId, table.occurredAt),
    index('events_project_type_idx').on(table.projectId, table.type),
  ],
);
