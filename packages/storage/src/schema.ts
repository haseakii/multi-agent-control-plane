import {
  index,
  blob,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const payload = () => text('payload').notNull();

export const inputAttachments = sqliteTable('input_attachments', {
  id: text('id').primaryKey().notNull(),
  payload: payload(),
  content: blob('content', { mode: 'buffer' }).notNull(),
});
export const inputAttachmentMessages = sqliteTable(
  'input_attachment_messages',
  {
    ownerId: text('owner_id').primaryKey().notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    idsJson: text('ids_json').notNull(),
  },
  (table) => [index('input_attachment_messages_task').on(table.taskId)],
);

export const networkSettings = sqliteTable('network_settings', {
  id: text('id').primaryKey().notNull(),
  revision: integer('revision').notNull(),
  globalJson: text('global_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const agentNetworkSettings = sqliteTable('agent_network_settings', {
  agentId: text('agent_id')
    .primaryKey()
    .notNull()
    .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
  payload: payload(),
});
export const executionNetworkObservations = sqliteTable(
  'execution_network_observations',
  {
    attemptId: text('attempt_id')
      .primaryKey()
      .notNull()
      .references(() => executionAttempts.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    payload: payload(),
  },
  (table) => [index('execution_network_task_idx').on(table.taskId)],
);

export const agentCatalogSources = sqliteTable(
  'agent_catalog_sources',
  {
    agentId: text('agent_id')
      .primaryKey()
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: 'cascade' }),
    entryId: text('entry_id').notNull(),
    revision: integer('revision').notNull(),
    payload: payload(),
  },
  (table) => [index('agent_catalog_sources_entry_idx').on(table.entryId)],
);

export const agentSessionPresets = sqliteTable(
  'agent_session_presets',
  {
    agentId: text('agent_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    revision: integer('revision').notNull(),
    archived: integer('archived').notNull(),
    payload: payload(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.id] }),
    uniqueIndex('agent_session_presets_active_name_idx')
      .on(table.agentId, sql`${table.name} COLLATE NOCASE`)
      .where(sql`${table.archived} = 0`),
  ],
);

export const agentSessionDefaults = sqliteTable('agent_session_defaults', {
  agentId: text('agent_id').primaryKey().notNull(),
  revision: integer('revision').notNull(),
  valuesJson: text('values_json').notNull(),
});

export const taskSessionSettings = sqliteTable(
  'task_session_settings',
  {
    taskId: text('task_id').primaryKey().notNull(),
    agentId: text('agent_id').notNull(),
    state: text('state').notNull(),
    payload: payload(),
  },
  (table) => [index('task_session_settings_agent_idx').on(table.agentId)],
);

export const workspaceCleanups = sqliteTable(
  'workspace_cleanups',
  {
    id: text('id')
      .primaryKey()
      .notNull()
      .references(() => workspaces.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    state: text('state').notNull(),
    payload: payload(),
  },
  (table) => [index('workspace_cleanups_task_idx').on(table.taskId)],
);

export const workspacePushes = sqliteTable(
  'workspace_pushes',
  {
    id: text('id').primaryKey().notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    reviewId: text('review_id')
      .notNull()
      .references(() => workspaceReviews.id),
    approvalId: text('approval_id')
      .notNull()
      .references(() => approvals.id),
    state: text('state').notNull(),
    payload: payload(),
  },
  (table) => [index('workspace_pushes_task_idx').on(table.taskId)],
);

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  payload: payload(),
});
export const projectPolicies = sqliteTable('project_policies', {
  id: text('id')
    .primaryKey()
    .notNull()
    .references(() => projects.id),
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
    branchName: text('branch_name'),
    payload: payload(),
  },
  (table) => [
    index('workspaces_project_idx').on(table.projectId),
    index('workspaces_project_branch_idx').on(table.projectId, table.branchName),
  ],
);

export const workspaceDirectoryBindings = sqliteTable(
  'workspace_directory_bindings',
  {
    id: text('id')
      .primaryKey()
      .references(() => workspaces.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    pathKey: text('path_key').notNull(),
    deviceId: text('device_id').notNull(),
    fileId: text('file_id').notNull(),
    payload: payload(),
  },
  (table) => [
    uniqueIndex('workspace_binding_path_idx').on(table.pathKey),
    uniqueIndex('workspace_binding_identity_idx').on(table.deviceId, table.fileId),
  ],
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

export const projectWorkspaceConfigs = sqliteTable('project_workspace_configs', {
  id: text('id')
    .primaryKey()
    .references(() => projects.id),
  sourceWorkspaceId: text('source_workspace_id')
    .notNull()
    .references(() => workspaces.id),
  payload: payload(),
});

export const assignmentWorkspaces = sqliteTable(
  'assignment_workspaces',
  {
    id: text('id')
      .primaryKey()
      .references(() => assignments.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    sourceWorkspaceId: text('source_workspace_id')
      .notNull()
      .references(() => workspaces.id),
    payload: payload(),
  },
  (table) => [index('assignment_workspaces_task_idx').on(table.taskId)],
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
    idempotencyKey: text('idempotency_key'),
    createdAt: text('created_at').notNull(),
    payload: payload(),
  },
  (table) => [
    index('messages_project_created_idx').on(table.projectId, table.createdAt),
    index('messages_recipient_idx').on(table.toAgentId, table.createdAt),
    uniqueIndex('messages_idempotency_unique_idx').on(
      table.projectId,
      table.fromAgentId,
      table.idempotencyKey,
    ),
  ],
);

export const messageDeliveries = sqliteTable(
  'message_deliveries',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    projectId: text('project_id').notNull(),
    recipientAgentId: text('recipient_agent_id').notNull(),
    mailboxKey: text('mailbox_key').notNull(),
    sequence: integer('sequence').notNull(),
    state: text('state').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    availableAt: text('available_at').notNull(),
    leaseUntil: text('lease_until'),
    payload: payload(),
  },
  (table) => [
    index('message_deliveries_recipient_state_idx').on(
      table.recipientAgentId,
      table.state,
      table.availableAt,
    ),
    index('message_deliveries_mailbox_sequence_idx').on(table.mailboxKey, table.sequence),
    index('message_deliveries_message_idx').on(table.messageId),
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

export const artifactLinks = sqliteTable(
  'artifact_links',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id').notNull(),
    projectId: text('project_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    createdAt: text('created_at').notNull(),
    payload: payload(),
  },
  (table) => [
    uniqueIndex('artifact_links_target_unique_idx').on(
      table.artifactId,
      table.entityType,
      table.entityId,
    ),
    index('artifact_links_project_idx').on(table.projectId),
    index('artifact_links_entity_idx').on(table.entityType, table.entityId),
  ],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    taskId: text('task_id'),
    assignmentId: text('assignment_id'),
    action: text('action'),
    enforcementMode: text('enforcement_mode'),
    boundary: text('boundary'),
    state: text('state').notNull(),
    requestedAt: text('requested_at'),
    payload: payload(),
  },
  (table) => [
    index('approvals_project_state_idx').on(table.projectId, table.state),
    index('approvals_project_pending_time_idx').on(table.projectId, table.state, table.requestedAt),
  ],
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
    index('events_project_task_time_idx').on(
      table.projectId,
      sql`json_extract(${table.payload}, '$.taskId')`,
      table.occurredAt,
    ),
  ],
);

export const taskInstructions = sqliteTable(
  'task_instructions',
  {
    id: text('id').primaryKey().notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    state: text('state').notNull(),
    ownerAttemptId: text('owner_attempt_id').references(() => executionAttempts.id),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    payload: payload(),
  },
  (table) => [index('task_instructions_task_state_idx').on(table.taskId, table.state)],
);

export const projectMemory = sqliteTable(
  'project_memory',
  {
    id: text('id').primaryKey().notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    status: text('status').notNull(),
    payload: payload(),
  },
  (table) => [index('project_memory_project_status_idx').on(table.projectId, table.status)],
);

export const workspaceReviews = sqliteTable(
  'workspace_reviews',
  {
    id: text('id').primaryKey().notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    assignmentId: text('assignment_id')
      .notNull()
      .references(() => assignments.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    approvalId: text('approval_id')
      .notNull()
      .references(() => approvals.id),
    state: text('state').notNull(),
    payload: payload(),
  },
  (table) => [index('workspace_reviews_task_idx').on(table.taskId)],
);
export const externalClients = sqliteTable('external_clients', {
  id: text('id').primaryKey().notNull(),
  payload: payload(),
});
export const agentInstallations = sqliteTable('agent_installations', {
  id: text('id').primaryKey().notNull(),
  payload: payload(),
});
