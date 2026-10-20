import type {
  AgentDefinition,
  AgentMessage,
  Approval,
  Artifact,
  Assignment,
  AuditEvent,
  BossAssignment,
  ConversationRef,
  ExecutionAttempt,
  Project,
  Runner,
  Task,
  Workspace,
} from '@control-plane/core';
import {
  AgentDefinitionSchema,
  AgentMessageSchema,
  ApprovalSchema,
  ArtifactSchema,
  AssignmentSchema,
  AuditEventSchema,
  BossAssignmentSchema,
  ConversationRefSchema,
  ExecutionAttemptSchema,
  ProjectSchema,
  RunnerSchema,
  TaskSchema,
  WorkspaceSchema,
} from '@control-plane/core';
import type Database from 'better-sqlite3';
import { assertNoPotentialSecrets } from './secrets.js';

type RuntimeSchema<T> = {
  parse(value: unknown): T;
};

type ProjectionValue = string | number | null;
type Projection<T> = (value: T) => Record<string, ProjectionValue>;

export interface EntityRepository<T extends { id: string }> {
  upsert(value: unknown): T;
  get(id: string): T | undefined;
  list(): T[];
  delete(id: string): boolean;
}

function assertSqlIdentifier(value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new TypeError(`Unsafe SQL identifier: ${value}`);
  }
}

class SqliteJsonRepository<T extends { id: string }> implements EntityRepository<T> {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly table: string,
    private readonly schema: RuntimeSchema<T>,
    private readonly projection: Projection<T> = () => ({}),
    private readonly guard?: (value: T) => void,
  ) {
    assertSqlIdentifier(table);
  }

  upsert(input: unknown): T {
    const value = this.schema.parse(input);
    this.guard?.(value);

    const projected = this.projection(value);
    for (const column of Object.keys(projected)) {
      assertSqlIdentifier(column);
    }

    const columns = ['id', ...Object.keys(projected), 'payload'];
    const placeholders = columns.map((column) => `@${column}`);
    const updateColumns = columns
      .filter((column) => column !== 'id')
      .map((column) => `${column}=excluded.${column}`);

    this.sqlite
      .prepare(
        `INSERT INTO ${this.table} (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT(id) DO UPDATE SET ${updateColumns.join(', ')}`,
      )
      .run({
        id: value.id,
        ...projected,
        payload: JSON.stringify(value),
      });

    return structuredClone(value);
  }

  get(id: string): T | undefined {
    const row = this.sqlite.prepare(`SELECT payload FROM ${this.table} WHERE id = ?`).get(id) as
      | { payload: string }
      | undefined;
    return row ? this.schema.parse(JSON.parse(row.payload)) : undefined;
  }

  list(): T[] {
    const rows = this.sqlite
      .prepare(`SELECT payload FROM ${this.table} ORDER BY rowid`)
      .all() as Array<{ payload: string }>;
    return rows.map((row) => this.schema.parse(JSON.parse(row.payload)));
  }

  delete(id: string): boolean {
    return this.sqlite.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes > 0;
  }
}

export interface EventRepository {
  append(value: unknown): AuditEvent;
  get(id: string): AuditEvent | undefined;
  listByProject(projectId: string): AuditEvent[];
}

class SqliteEventRepository implements EventRepository {
  constructor(private readonly sqlite: Database.Database) {}

  append(input: unknown): AuditEvent {
    const event = AuditEventSchema.parse(input);
    assertNoPotentialSecrets(event);

    this.sqlite
      .prepare(
        `INSERT INTO events (id, project_id, type, occurred_at, payload)
         VALUES (@id, @projectId, @type, @occurredAt, @payload)`,
      )
      .run({
        id: event.id,
        projectId: event.projectId,
        type: event.type,
        occurredAt: event.occurredAt,
        payload: JSON.stringify(event),
      });

    return structuredClone(event);
  }

  get(id: string): AuditEvent | undefined {
    const row = this.sqlite.prepare('SELECT payload FROM events WHERE id = ?').get(id) as
      | { payload: string }
      | undefined;
    return row ? AuditEventSchema.parse(JSON.parse(row.payload)) : undefined;
  }

  listByProject(projectId: string): AuditEvent[] {
    const rows = this.sqlite
      .prepare('SELECT payload FROM events WHERE project_id = ? ORDER BY occurred_at, rowid')
      .all(projectId) as Array<{ payload: string }>;
    return rows.map((row) => AuditEventSchema.parse(JSON.parse(row.payload)));
  }
}

export type StorageRepositories = {
  projects: EntityRepository<Project>;
  agentDefinitions: EntityRepository<AgentDefinition>;
  bossAssignments: EntityRepository<BossAssignment>;
  runners: EntityRepository<Runner>;
  workspaces: EntityRepository<Workspace>;
  tasks: EntityRepository<Task>;
  assignments: EntityRepository<Assignment>;
  executionAttempts: EntityRepository<ExecutionAttempt>;
  conversations: EntityRepository<ConversationRef>;
  messages: EntityRepository<AgentMessage>;
  artifacts: EntityRepository<Artifact>;
  approvals: EntityRepository<Approval>;
  events: EventRepository;
  transaction<T>(operation: () => T): T;
};

export function createRepositories(sqlite: Database.Database): StorageRepositories {
  return {
    projects: new SqliteJsonRepository(sqlite, 'projects', ProjectSchema),
    agentDefinitions: new SqliteJsonRepository(sqlite, 'agent_definitions', AgentDefinitionSchema),
    bossAssignments: new SqliteJsonRepository(
      sqlite,
      'boss_assignments',
      BossAssignmentSchema,
      (value) => ({ project_id: value.projectId }),
    ),
    runners: new SqliteJsonRepository(sqlite, 'runners', RunnerSchema),
    workspaces: new SqliteJsonRepository(sqlite, 'workspaces', WorkspaceSchema, (value) => ({
      project_id: value.projectId,
      branch_name: value.branchName ?? null,
    })),
    tasks: new SqliteJsonRepository(
      sqlite,
      'tasks',
      TaskSchema,
      (value) => ({
        project_id: value.projectId,
        parent_task_id: value.parentTaskId ?? null,
        state: value.state,
        updated_at: value.updatedAt,
      }),
      assertNoPotentialSecrets,
    ),
    assignments: new SqliteJsonRepository(sqlite, 'assignments', AssignmentSchema, (value) => ({
      task_id: value.taskId,
      agent_id: value.agentId,
      state: value.state,
    })),
    executionAttempts: new SqliteJsonRepository(
      sqlite,
      'execution_attempts',
      ExecutionAttemptSchema,
      (value) => ({
        task_id: value.taskId,
        assignment_id: value.assignmentId,
        state: value.state,
        number: value.number,
      }),
    ),
    conversations: new SqliteJsonRepository(
      sqlite,
      'conversations',
      ConversationRefSchema,
      (value) => ({
        task_id: value.taskId,
        assignment_id: value.assignmentId,
        execution_attempt_id: value.executionAttemptId,
        agent_id: value.agentId,
        runner_id: value.runnerId,
      }),
    ),
    messages: new SqliteJsonRepository(
      sqlite,
      'messages',
      AgentMessageSchema,
      (value) => ({
        project_id: value.projectId,
        task_id: value.taskId ?? null,
        from_agent_id: value.fromAgentId,
        to_agent_id: value.toAgentId ?? null,
        type: value.type,
        idempotency_key: value.idempotencyKey ?? null,
        created_at: value.createdAt,
      }),
      assertNoPotentialSecrets,
    ),
    artifacts: new SqliteJsonRepository(sqlite, 'artifacts', ArtifactSchema, (value) => ({
      project_id: value.projectId,
      task_id: value.taskId ?? null,
      sha256: value.sha256,
    })),
    approvals: new SqliteJsonRepository(sqlite, 'approvals', ApprovalSchema, (value) => ({
      project_id: value.projectId,
      task_id: value.taskId ?? null,
      assignment_id: value.assignmentId ?? null,
      action: value.action,
      enforcement_mode: value.enforcementMode,
      boundary: value.boundary ?? null,
      state: value.state,
      requested_at: value.requestedAt,
    })),
    events: new SqliteEventRepository(sqlite),
    transaction<T>(operation: () => T): T {
      return sqlite.transaction(operation)();
    },
  };
}
