import { z } from 'zod';

export const ProjectIdSchema = z.string().min(1).max(128).brand<'ProjectId'>();
export const AgentIdSchema = z.string().min(1).max(128).brand<'AgentId'>();
export const BossAssignmentIdSchema = z.string().min(1).max(128).brand<'BossAssignmentId'>();
export const TaskIdSchema = z.string().min(1).max(128).brand<'TaskId'>();
export const AssignmentIdSchema = z.string().min(1).max(128).brand<'AssignmentId'>();
export const ExecutionAttemptIdSchema = z.string().min(1).max(128).brand<'ExecutionAttemptId'>();
export const ConversationIdSchema = z.string().min(1).max(128).brand<'ConversationId'>();
export const MessageIdSchema = z.string().min(1).max(128).brand<'MessageId'>();
export const ArtifactIdSchema = z.string().min(1).max(128).brand<'ArtifactId'>();
export const ApprovalIdSchema = z.string().min(1).max(128).brand<'ApprovalId'>();
export const RunnerIdSchema = z.string().min(1).max(128).brand<'RunnerId'>();
export const WorkspaceIdSchema = z.string().min(1).max(128).brand<'WorkspaceId'>();
export const AuditEventIdSchema = z.string().min(1).max(128).brand<'AuditEventId'>();

export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type BossAssignmentId = z.infer<typeof BossAssignmentIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type AssignmentId = z.infer<typeof AssignmentIdSchema>;
export type ExecutionAttemptId = z.infer<typeof ExecutionAttemptIdSchema>;
export type ConversationId = z.infer<typeof ConversationIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export type RunnerId = z.infer<typeof RunnerIdSchema>;
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type AuditEventId = z.infer<typeof AuditEventIdSchema>;

export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

export const TimestampSchema = z.iso.datetime({ offset: true });

export const CapabilitySourceSchema = z.enum(['configured', 'advertised', 'verified']);
export const CapabilitySchema = z
  .object({
    name: z.string().min(1).max(128),
    source: CapabilitySourceSchema,
  })
  .strict();
export type Capability = z.infer<typeof CapabilitySchema>;

export const AcpStdioRuntimeDefinitionSchema = z
  .object({
    type: z.literal('acp-stdio'),
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).optional(),
    environmentAllowlist: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type AcpStdioRuntimeDefinition = z.infer<typeof AcpStdioRuntimeDefinitionSchema>;
export const RuntimeDefinitionSchema = AcpStdioRuntimeDefinitionSchema;
export type RuntimeDefinition = z.infer<typeof RuntimeDefinitionSchema>;

export const AgentAuthSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('agent-managed') }).strict(),
  z
    .object({
      mode: z.literal('secret-ref'),
      secretRef: z.string().min(1),
    })
    .strict(),
]);
export type AgentAuth = z.infer<typeof AgentAuthSchema>;

export const BridgeTransportSchema = z.enum(['mcp', 'cli', 'structured', 'none']);
export const BridgeScopeSchema = z.enum([
  'boss.orchestration',
  'agent.messaging',
  'artifact.read',
  'artifact.publish',
  'task.status',
]);
export type BridgeScope = z.infer<typeof BridgeScopeSchema>;

export const ControlBridgeSchema = z
  .object({
    transport: BridgeTransportSchema,
    scopes: z.array(BridgeScopeSchema),
  })
  .strict()
  .superRefine((bridge, ctx) => {
    if (bridge.transport === 'none' && bridge.scopes.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'A disabled control bridge cannot grant scopes.',
        path: ['scopes'],
      });
    }
  });

export const RunnerSelectorSchema = z
  .object({
    os: z.string().min(1).optional(),
    labels: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const AgentDefinitionSchema = z
  .object({
    id: AgentIdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean(),
    runtime: RuntimeDefinitionSchema,
    capabilities: z.array(CapabilitySchema),
    auth: AgentAuthSchema,
    permissions: z.string().min(1).optional(),
    runnerSelector: RunnerSelectorSchema.optional(),
    orchestration: z
      .object({
        canBeBoss: z.boolean(),
      })
      .strict(),
    controlBridge: ControlBridgeSchema,
  })
  .strict();
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const ProjectSchema = z
  .object({
    id: ProjectIdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    defaultBossAgentId: AgentIdSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;

export const BossOperationSchema = z.enum([
  'agents.discover',
  'tasks.create',
  'tasks.delegate',
  'tasks.read',
  'tasks.wait',
  'messages.send',
  'tasks.cancel',
  'artifacts.read',
  'artifacts.publish',
  'approvals.request',
]);

export const BossAssignmentSchema = z
  .object({
    id: BossAssignmentIdSchema,
    projectId: ProjectIdSchema,
    agentId: AgentIdSchema,
    allowedOperations: z.array(BossOperationSchema),
    maxWorkers: z.number().int().positive(),
    maxTaskDepth: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
  })
  .strict();
export type BossAssignment = z.infer<typeof BossAssignmentSchema>;

export const TaskStateSchema = z.enum([
  'draft',
  'planning',
  'ready',
  'running',
  'waiting',
  'waiting_approval',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

export const TaskSchema = z
  .object({
    id: TaskIdSchema,
    projectId: ProjectIdSchema,
    parentTaskId: TaskIdSchema.optional(),
    title: z.string().min(1),
    objective: z.string().min(1),
    state: TaskStateSchema,
    ownerAgentId: AgentIdSchema.optional(),
    dependencyIds: z.array(TaskIdSchema),
    contextRefs: z.array(z.string().min(1)),
    resultArtifactRefs: z.array(ArtifactIdSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;

const AssignmentRoleSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

export const AssignmentStateSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);

export const AssignmentSchema = z
  .object({
    id: AssignmentIdSchema,
    taskId: TaskIdSchema,
    agentId: AgentIdSchema,
    role: AssignmentRoleSchema.optional(),
    objective: z.string().min(1),
    state: AssignmentStateSchema,
    attempt: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Assignment = z.infer<typeof AssignmentSchema>;

export const ExecutionAttemptStateSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export const ExecutionAttemptFailureSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

export const ExecutionAttemptSchema = z
  .object({
    id: ExecutionAttemptIdSchema,
    taskId: TaskIdSchema,
    assignmentId: AssignmentIdSchema,
    number: z.number().int().positive(),
    state: ExecutionAttemptStateSchema,
    runnerId: RunnerIdSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
    failure: ExecutionAttemptFailureSchema.optional(),
  })
  .strict();
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;

export const ConversationRefSchema = z
  .object({
    id: ConversationIdSchema,
    taskId: TaskIdSchema,
    assignmentId: AssignmentIdSchema,
    executionAttemptId: ExecutionAttemptIdSchema,
    agentId: AgentIdSchema,
    runnerId: RunnerIdSchema,
    protocol: z.string().min(1),
    sessionId: z.string().min(1),
    createdAt: TimestampSchema,
  })
  .strict();
export type ConversationRef = z.infer<typeof ConversationRefSchema>;

export const AgentMessageTypeSchema = z.enum([
  'request',
  'response',
  'message',
  'handoff',
  'event',
  'status',
]);

export const AgentMessageSchema = z
  .object({
    id: MessageIdSchema,
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema.optional(),
    fromAgentId: AgentIdSchema,
    toAgentId: AgentIdSchema.optional(),
    type: AgentMessageTypeSchema,
    correlationId: z.string().min(1).optional(),
    replyTo: MessageIdSchema.optional(),
    idempotencyKey: z.string().min(1).optional(),
    content: z.string().optional(),
    artifactRefs: z.array(ArtifactIdSchema),
    metadata: z.record(z.string(), JsonValueSchema),
    createdAt: TimestampSchema,
  })
  .strict();
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const ArtifactKindSchema = z.enum([
  'plan',
  'report',
  'patch',
  'diff',
  'log',
  'image',
  'test-report',
  'file',
  'directory-manifest',
  'json',
  'text',
]);

export const ArtifactSchema = z
  .object({
    id: ArtifactIdSchema,
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema.optional(),
    assignmentId: AssignmentIdSchema.optional(),
    producerAgentId: AgentIdSchema.optional(),
    kind: ArtifactKindSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    storageKey: z.string().min(1),
    createdAt: TimestampSchema,
  })
  .strict();
export type Artifact = z.infer<typeof ArtifactSchema>;

export const EnforcementModeSchema = z.enum(['enforced', 'cooperative', 'unavailable']);
export const ApprovalStateSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);

export const ApprovalSchema = z
  .object({
    id: ApprovalIdSchema,
    projectId: ProjectIdSchema,
    taskId: TaskIdSchema.optional(),
    requesterAgentId: AgentIdSchema.optional(),
    action: z.string().min(1),
    resource: JsonValueSchema,
    enforcementMode: EnforcementModeSchema,
    state: ApprovalStateSchema,
    requestedAt: TimestampSchema,
    decidedAt: TimestampSchema.optional(),
    decisionActor: z.string().min(1).optional(),
  })
  .strict();
export type Approval = z.infer<typeof ApprovalSchema>;

export const RunnerStatusSchema = z.enum(['unknown', 'ready', 'busy', 'offline', 'error']);

export const RunnerSchema = z
  .object({
    id: RunnerIdSchema,
    kind: z.string().min(1),
    labels: z.array(z.string().min(1)),
    capabilities: z.array(z.string().min(1)),
    status: RunnerStatusSchema,
  })
  .strict();
export type Runner = z.infer<typeof RunnerSchema>;

export const WorkspaceProviderSchema = z.enum(['local-directory', 'git-worktree']);
export const WorkspaceAccessSchema = z.enum(['read-only', 'read-write']);

export const WorkspaceSchema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: ProjectIdSchema,
    runnerId: RunnerIdSchema.optional(),
    provider: WorkspaceProviderSchema,
    rootPath: z.string().min(1),
    access: WorkspaceAccessSchema,
    repositoryId: z.string().min(1).optional(),
    baseRevision: z.string().min(1).optional(),
  })
  .strict();
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const AuditActorSchema = z
  .object({
    type: z.enum(['user', 'agent', 'system']),
    id: z.string().min(1),
  })
  .strict();

export const AuditEventSchema = z
  .object({
    id: AuditEventIdSchema,
    projectId: ProjectIdSchema,
    type: z.string().min(1),
    actor: AuditActorSchema,
    taskId: TaskIdSchema.optional(),
    assignmentId: AssignmentIdSchema.optional(),
    messageId: MessageIdSchema.optional(),
    payload: z.record(z.string(), JsonValueSchema),
    occurredAt: TimestampSchema,
  })
  .strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;
