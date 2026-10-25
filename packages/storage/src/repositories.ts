import { SqliteAgentReferenceReader, type AgentReferenceReader } from './agent-references.js';
import type {
  AgentDefinition,
  ExternalClientRecord,
  AgentInstallation,
  AgentMessage,
  Approval,
  ApprovalReadResult,
  Artifact,
  Assignment,
  AuditEvent,
  BossAssignment,
  ConversationRef,
  ExecutionAttempt,
  Project,
  Runner,
  Task,
  TaskInstruction,
  Workspace,
  WorkspaceDirectoryBinding,
  ProjectWorkspaceConfig,
  AssignmentWorkspace,
  ProjectMemory,
  WorkspaceReview,
  WorkspacePush,
  WorkspaceCleanup,
  ProjectPolicy,
} from '@control-plane/core';
import {
  ExternalClientRecordSchema,
  AgentInstallationSchema,
  AgentDefinitionSchema,
  AgentMessageSchema,
  ApprovalSchema,
  ApprovalReadDiagnosticsSchema,
  ArtifactSchema,
  AssignmentSchema,
  AuditEventSchema,
  BossAssignmentSchema,
  ConversationRefSchema,
  ExecutionAttemptSchema,
  ProjectSchema,
  RunnerSchema,
  TaskSchema,
  TaskInstructionSchema,
  WorkspaceSchema,
  WorkspaceDirectoryBindingSchema,
  ProjectWorkspaceConfigSchema,
  AssignmentWorkspaceSchema,
  ProjectMemorySchema,
  WorkspaceReviewSchema,
  WorkspacePushSchema,
  WorkspaceCleanupSchema,
  ProjectPolicySchema,
} from '@control-plane/core';
import type Database from 'better-sqlite3';
import {
  assertNoPermissionSecrets,
  assertNoPotentialSecrets,
  PotentialSecretError,
  SensitiveApprovalReadError,
  ApprovalRecordIntegrityError,
} from './secrets.js';

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

export interface ApprovalRepository extends EntityRepository<Approval> {
  /** Only proven sensitive-content refusals are omitted; other failures throw. */
  listWithDiagnostics(): ApprovalReadResult;
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
    private readonly guardReads = false,
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
    if (!row) return undefined;
    const value = this.schema.parse(JSON.parse(row.payload));
    if (this.guardReads) this.guard?.(value);
    return value;
  }

  list(): T[] {
    const rows = this.sqlite
      .prepare(`SELECT payload FROM ${this.table} ORDER BY rowid`)
      .all() as Array<{ payload: string }>;
    return rows.map((row) => {
      const value = this.schema.parse(JSON.parse(row.payload));
      if (this.guardReads) this.guard?.(value);
      return value;
    });
  }

  delete(id: string): boolean {
    return this.sqlite.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id).changes > 0;
  }
}

function guardApproval(value: Approval): void {
  if (
    value.acp ||
    value.boundary === 'acp-permission' ||
    (value.action === 'acp.tool' && value.boundary === undefined)
  )
    assertNoPermissionSecrets(value);
}

function parseApprovalRow(row: { id: string; payload: string }): Approval {
  let json: unknown;
  try {
    json = JSON.parse(row.payload);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ApprovalRecordIntegrityError();
    throw error;
  }
  const parsed = ApprovalSchema.safeParse(json);
  if (!parsed.success || parsed.data.id !== row.id) throw new ApprovalRecordIntegrityError();
  return parsed.data;
}

class SqliteApprovalRepository
  extends SqliteJsonRepository<Approval>
  implements ApprovalRepository
{
  constructor(private readonly approvalDb: Database.Database) {
    super(
      approvalDb,
      'approvals',
      ApprovalSchema,
      (value) => ({
        project_id: value.projectId,
        task_id: value.taskId ?? null,
        assignment_id: value.assignmentId ?? null,
        action: value.action,
        enforcement_mode: value.enforcementMode,
        boundary: value.boundary ?? null,
        state: value.state,
        requested_at: value.requestedAt,
      }),
      guardApproval,
      true,
    );
  }
  override get(id: string): Approval | undefined {
    const row = this.approvalDb.prepare('SELECT id,payload FROM approvals WHERE id=?').get(id) as
      | { id: string; payload: string }
      | undefined;
    if (!row) return undefined;
    const value = parseApprovalRow(row);
    try {
      guardApproval(value);
    } catch (error) {
      if (error instanceof PotentialSecretError) throw new SensitiveApprovalReadError();
      throw error;
    }
    return value;
  }
  override upsert(input: unknown): Approval {
    const value = ApprovalSchema.parse(input);
    guardApproval(value);
    // A safe-looking replacement must not silently repair an isolated raw row.
    this.get(value.id);
    return super.upsert(value);
  }
  override delete(id: string): boolean {
    this.get(id);
    return super.delete(id);
  }
  override list(): Approval[] {
    return this.listWithDiagnostics().approvals;
  }
  listWithDiagnostics(): ApprovalReadResult {
    const rows = this.approvalDb
      .prepare('SELECT id,payload FROM approvals ORDER BY rowid')
      .all() as Array<{ id: string; payload: string }>;
    const approvals: Approval[] = [];
    let count = 0;
    for (const row of rows) {
      // Parsing is outside the sensitive-only catch. Never hide corruption.
      const value = parseApprovalRow(row);
      try {
        guardApproval(value);
      } catch (error) {
        if (error instanceof PotentialSecretError) {
          count++;
          continue;
        }
        throw error;
      }
      approvals.push(value);
    }
    return {
      approvals,
      diagnostics: ApprovalReadDiagnosticsSchema.parse({
        code: 'APPROVAL_SENSITIVE_RECORDS_ISOLATED',
        count,
      }),
    };
  }
}

export type EventSelection = { taskIds: readonly string[]; types: readonly string[] };
export interface EventRepository {
  append(value: unknown): AuditEvent;
  get(id: string): AuditEvent | undefined;
  listByProject(projectId: string, selection?: EventSelection): AuditEvent[];
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

  listByProject(projectId: string, selection?: EventSelection): AuditEvent[] {
    if (
      selection &&
      (!Array.isArray(selection.taskIds) ||
        !Array.isArray(selection.types) ||
        [...selection.taskIds, ...selection.types].some(
          (value) => typeof value !== 'string' || !value.length,
        ))
    )
      throw new TypeError('Event selection requires task and type string lists.');
    const rows = selection
      ? (this.sqlite
          .prepare(
            `
      SELECT payload FROM (
        SELECT rowid AS sequence, occurred_at, payload FROM events
        WHERE project_id = @projectId AND type IN (SELECT value FROM json_each(@types))
        UNION
        SELECT rowid AS sequence, occurred_at, payload FROM events
        WHERE project_id = @projectId AND json_extract(payload, '$.taskId') IN (SELECT value FROM json_each(@taskIds))
      ) ORDER BY occurred_at, sequence
    `,
          )
          .all({
            projectId,
            types: JSON.stringify(selection.types),
            taskIds: JSON.stringify(selection.taskIds),
          }) as Array<{ payload: string }>)
      : (this.sqlite
          .prepare('SELECT payload FROM events WHERE project_id = ? ORDER BY occurred_at, rowid')
          .all(projectId) as Array<{ payload: string }>);
    return rows.map((row) => AuditEventSchema.parse(JSON.parse(row.payload)));
  }
}

export type StorageRepositories = {
  externalClients: EntityRepository<ExternalClientRecord>;
  agentInstallations: EntityRepository<AgentInstallation>;
  agentReferences: AgentReferenceReader;
  projects: EntityRepository<Project>;
  agentDefinitions: EntityRepository<AgentDefinition>;
  bossAssignments: EntityRepository<BossAssignment>;
  runners: EntityRepository<Runner>;
  workspaces: EntityRepository<Workspace>;
  workspaceDirectoryBindings: EntityRepository<WorkspaceDirectoryBinding>;
  projectWorkspaceConfigs: EntityRepository<ProjectWorkspaceConfig>;
  assignmentWorkspaces: EntityRepository<AssignmentWorkspace>;
  tasks: EntityRepository<Task>;
  taskInstructions: EntityRepository<TaskInstruction>;
  projectMemory: EntityRepository<ProjectMemory>;
  workspaceReviews: EntityRepository<WorkspaceReview>;
  workspacePushes: EntityRepository<WorkspacePush>;
  workspaceCleanups: EntityRepository<WorkspaceCleanup>;
  projectPolicies: EntityRepository<ProjectPolicy>;
  assignments: EntityRepository<Assignment>;
  executionAttempts: EntityRepository<ExecutionAttempt>;
  conversations: EntityRepository<ConversationRef>;
  messages: EntityRepository<AgentMessage>;
  artifacts: EntityRepository<Artifact>;
  approvals: ApprovalRepository;
  events: EventRepository;
  transaction<T>(operation: () => T): T;
};

export function createRepositories(sqlite: Database.Database): StorageRepositories {
  return {
    agentReferences: new SqliteAgentReferenceReader(sqlite),
    workspaceCleanups: new SqliteJsonRepository(
      sqlite,
      'workspace_cleanups',
      WorkspaceCleanupSchema,
      (value) => ({ project_id: value.projectId, task_id: value.taskId, state: value.state }),
      assertNoPotentialSecrets,
    ),
    workspacePushes: new SqliteJsonRepository(
      sqlite,
      'workspace_pushes',
      WorkspacePushSchema,
      (value) => ({
        project_id: value.projectId,
        task_id: value.taskId,
        review_id: value.reviewId,
        approval_id: value.approvalId,
        state: value.state,
      }),
      assertNoPotentialSecrets,
    ),
    projects: new SqliteJsonRepository(sqlite, 'projects', ProjectSchema),
    projectPolicies: new SqliteJsonRepository(sqlite, 'project_policies', ProjectPolicySchema),
    workspaceReviews: new SqliteJsonRepository(
      sqlite,
      'workspace_reviews',
      WorkspaceReviewSchema,
      (value) => ({
        project_id: value.projectId,
        task_id: value.taskId,
        assignment_id: value.assignmentId,
        workspace_id: value.workspaceId,
        approval_id: value.approvalId,
        state: value.state,
      }),
      assertNoPotentialSecrets,
    ),
    projectMemory: new SqliteJsonRepository(
      sqlite,
      'project_memory',
      ProjectMemorySchema,
      (value) => ({ project_id: value.projectId, status: value.status }),
      assertNoPotentialSecrets,
    ),
    projectWorkspaceConfigs: new SqliteJsonRepository(
      sqlite,
      'project_workspace_configs',
      ProjectWorkspaceConfigSchema,
      (value) => ({ source_workspace_id: value.sourceWorkspaceId }),
    ),
    assignmentWorkspaces: new SqliteJsonRepository(
      sqlite,
      'assignment_workspaces',
      AssignmentWorkspaceSchema,
      (value) => ({
        project_id: value.projectId,
        task_id: value.taskId,
        workspace_id: value.workspaceId,
        source_workspace_id: value.sourceWorkspaceId,
      }),
    ),
    agentDefinitions: new SqliteJsonRepository(sqlite, 'agent_definitions', AgentDefinitionSchema),
    externalClients: new SqliteJsonRepository(
      sqlite,
      'external_clients',
      ExternalClientRecordSchema,
    ),
    agentInstallations: new SqliteJsonRepository(
      sqlite,
      'agent_installations',
      AgentInstallationSchema,
    ),
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
    workspaceDirectoryBindings: new SqliteJsonRepository(
      sqlite,
      'workspace_directory_bindings',
      WorkspaceDirectoryBindingSchema,
      (value) => ({
        project_id: value.projectId,
        path_key: value.pathKey,
        device_id: value.deviceId,
        file_id: value.fileId,
      }),
    ),
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
    taskInstructions: new SqliteJsonRepository(
      sqlite,
      'task_instructions',
      TaskInstructionSchema,
      (value) => ({
        project_id: value.projectId,
        task_id: value.taskId,
        state: value.state,
        owner_attempt_id: value.ownerAttemptId ?? null,
        created_at: value.createdAt,
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
    approvals: new SqliteApprovalRepository(sqlite),
    events: new SqliteEventRepository(sqlite),
    transaction<T>(operation: () => T): T {
      return sqlite.transaction(operation)();
    },
  };
}
