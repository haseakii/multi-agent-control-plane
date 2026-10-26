import type {
  AgentAuthMethodSummary,
  AgentReadiness,
  AgentNegotiation,
} from '@control-plane/acp-runtime';
import { createHash } from 'node:crypto';
import {
  AgentDefinitionSchema,
  AgentMessageSchema,
  ApprovalSchema,
  ApprovalReadDiagnosticsSchema,
  ApprovalViewSchema,
  ApprovalDecisionEligibilitySchema,
  ArtifactSchema,
  AssignmentSchema,
  AuditEventSchema,
  ConversationRefSchema,
  ExecutionAttemptSchema,
  ProjectSchema,
  RunnerSchema,
  TaskSchema,
  WorkspaceSchema,
  ProjectWorkspaceConfigSchema,
  AssignmentWorkspaceSchema,
  WorkspaceCleanupSchema,
  MessageDeliveryViewSchema,
} from '@control-plane/core';
import type { SqliteStorage } from '@control-plane/storage';
import { SqliteMessageRouterStore, messageDeliveryView } from '@control-plane/message-router';
import { conversationTaskIds, type ControlCenterReadOptions } from './conversation-snapshot.js';

export type ControlCenterSnapshot = {
  generatedAt: string;
  projects: ReturnType<typeof ProjectSchema.parse>[];
  agents: Array<{
    definition: ReturnType<typeof AgentDefinitionSchema.parse>;
    readiness: AgentReadiness;
    authMethods: AgentAuthMethodSummary[];
    negotiation?: AgentNegotiation;
    localEntry?: { offlineChecksPassed: boolean; issues: Array<{ code: string; message: string }> };
    error?: string | undefined;
  }>;
  tasks: ReturnType<typeof TaskSchema.parse>[];
  assignments: ReturnType<typeof AssignmentSchema.parse>[];
  executionAttempts?: ReturnType<typeof ExecutionAttemptSchema.parse>[];
  timeline: ReturnType<typeof AuditEventSchema.parse>[];
  messages: ReturnType<typeof AgentMessageSchema.parse>[];
  messageDeliveries?: ReturnType<typeof MessageDeliveryViewSchema.parse>[];
  approvals: ReturnType<typeof ApprovalViewSchema.parse>[];
  approvalReadDiagnostics?: ReturnType<typeof ApprovalReadDiagnosticsSchema.parse>;
  artifacts: ReturnType<typeof ArtifactSchema.parse>[];
  runners: ReturnType<typeof RunnerSchema.parse>[];
  workspaces: ReturnType<typeof WorkspaceSchema.parse>[];
  workspaceConfigs?: ReturnType<typeof ProjectWorkspaceConfigSchema.parse>[];
  assignmentWorkspaces?: ReturnType<typeof AssignmentWorkspaceSchema.parse>[];
  workspaceCleanups?: ReturnType<typeof WorkspaceCleanupSchema.parse>[];
  directoryBindings?: Array<{
    id: string;
    projectId: string;
    rootPath: string;
    confirmationVersion?: string;
  }>;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function seedDemoState(storage: SqliteStorage): void {
  const repositories = storage.repositories;
  if (repositories.projects.get('demo-project')) {
    return;
  }

  const project = ProjectSchema.parse({
    id: 'demo-project',
    name: 'V0 multi-agent demo',
    description: 'Durable local demonstration project.',
    defaultBossAgentId: 'demo-boss',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:06:00.000Z',
  });
  repositories.projects.upsert(project);

  repositories.agentDefinitions.upsert(
    AgentDefinitionSchema.parse({
      id: 'demo-boss',
      name: 'Demo Boss ACP',
      description: 'Boss-capable ACP agent used by the deterministic V0 demo.',
      enabled: true,
      runtime: { type: 'acp-stdio', command: 'demo-boss-acp', args: [] },
      capabilities: [
        { name: 'planning', source: 'verified' },
        { name: 'code.read', source: 'verified' },
      ],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: true },
      controlBridge: {
        transport: 'mcp',
        scopes: ['boss.orchestration', 'agent.messaging', 'artifact.read', 'artifact.publish'],
      },
    }),
  );
  repositories.agentDefinitions.upsert(
    AgentDefinitionSchema.parse({
      id: 'demo-worker',
      name: 'Demo Worker ACP',
      description: 'Independent worker ACP agent selected by capability.',
      enabled: true,
      runtime: { type: 'acp-stdio', command: 'demo-worker-acp', args: [] },
      capabilities: [
        { name: 'code.read', source: 'verified' },
        { name: 'code.review', source: 'verified' },
      ],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    }),
  );

  repositories.runners.upsert(
    RunnerSchema.parse({
      id: 'local',
      kind: 'local',
      labels: ['demo'],
      capabilities: ['process.spawn', 'process.output'],
      status: 'ready',
    }),
  );
  repositories.workspaces.upsert(
    WorkspaceSchema.parse({
      id: 'demo-workspace',
      projectId: project.id,
      runnerId: 'local',
      provider: 'local-directory',
      rootPath: '/demo/workspace',
      access: 'read-write',
    }),
  );

  const rootTask = TaskSchema.parse({
    id: 'demo-root',
    projectId: project.id,
    title: 'Prepare V0 architecture summary',
    objective: 'Delegate a focused review and incorporate the durable result.',
    state: 'completed',
    ownerAgentId: 'demo-boss',
    dependencyIds: [],
    contextRefs: [],
    resultArtifactRefs: ['demo-artifact'],
    createdAt: '2026-10-20T00:01:00.000Z',
    updatedAt: '2026-10-20T00:06:00.000Z',
  });
  const childTask = TaskSchema.parse({
    id: 'demo-review',
    projectId: project.id,
    parentTaskId: rootTask.id,
    title: 'Review control-plane boundaries',
    objective: 'Review the V0 boundaries and return a concise result.',
    state: 'completed',
    ownerAgentId: 'demo-worker',
    dependencyIds: [],
    contextRefs: [],
    resultArtifactRefs: ['demo-artifact'],
    createdAt: '2026-10-20T00:02:00.000Z',
    updatedAt: '2026-10-20T00:05:00.000Z',
  });
  repositories.tasks.upsert(rootTask);
  repositories.tasks.upsert(childTask);

  repositories.assignments.upsert(
    AssignmentSchema.parse({
      id: 'demo-assignment-worker',
      taskId: childTask.id,
      agentId: 'demo-worker',
      role: { name: 'boundary reviewer' },
      objective: childTask.objective,
      state: 'completed',
      attempt: 1,
      createdAt: '2026-10-20T00:02:10.000Z',
      updatedAt: '2026-10-20T00:05:00.000Z',
    }),
  );
  repositories.executionAttempts.upsert(
    ExecutionAttemptSchema.parse({
      id: 'demo-attempt-worker',
      taskId: childTask.id,
      assignmentId: 'demo-assignment-worker',
      number: 1,
      state: 'completed',
      runnerId: 'local',
      createdAt: '2026-10-20T00:02:20.000Z',
      updatedAt: '2026-10-20T00:05:00.000Z',
      startedAt: '2026-10-20T00:02:30.000Z',
      finishedAt: '2026-10-20T00:05:00.000Z',
    }),
  );
  repositories.conversations.upsert(
    ConversationRefSchema.parse({
      id: 'demo-conversation-worker',
      taskId: childTask.id,
      assignmentId: 'demo-assignment-worker',
      executionAttemptId: 'demo-attempt-worker',
      agentId: 'demo-worker',
      runnerId: 'local',
      protocol: 'acp',
      sessionId: 'demo-worker-session',
      createdAt: '2026-10-20T00:02:30.000Z',
    }),
  );

  repositories.messages.upsert({
    id: 'demo-message-request',
    projectId: project.id,
    taskId: childTask.id,
    fromAgentId: 'demo-boss',
    toAgentId: 'demo-worker',
    type: 'request',
    correlationId: 'demo-correlation',
    idempotencyKey: 'demo-delegate-request',
    content: 'Review the V0 control-plane boundaries.',
    artifactRefs: [],
    metadata: {},
    createdAt: '2026-10-20T00:02:15.000Z',
  });
  repositories.messages.upsert({
    id: 'demo-message-response',
    projectId: project.id,
    taskId: childTask.id,
    fromAgentId: 'demo-worker',
    toAgentId: 'demo-boss',
    type: 'response',
    correlationId: 'demo-correlation',
    replyTo: 'demo-message-request',
    idempotencyKey: 'demo-review-response',
    content: 'Review complete; durable result published as an artifact.',
    artifactRefs: ['demo-artifact'],
    metadata: {},
    createdAt: '2026-10-20T00:05:00.000Z',
  });

  repositories.artifacts.upsert(
    ArtifactSchema.parse({
      id: 'demo-artifact',
      projectId: project.id,
      taskId: childTask.id,
      assignmentId: 'demo-assignment-worker',
      producerAgentId: 'demo-worker',
      kind: 'report',
      sha256: sha256('Demo worker durable result'),
      mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength('Demo worker durable result'),
      storageKey: `sha256/${sha256('Demo worker durable result').slice(0, 2)}/${sha256('Demo worker durable result')}`,
      createdAt: '2026-10-20T00:04:50.000Z',
    }),
  );
  repositories.approvals.upsert(
    ApprovalSchema.parse({
      id: 'demo-approval',
      projectId: project.id,
      taskId: childTask.id,
      requesterAgentId: 'demo-boss',
      action: 'workspace.write',
      resource: { workspaceId: 'demo-workspace' },
      enforcementMode: 'enforced',
      state: 'approved',
      requestedAt: '2026-10-20T00:02:05.000Z',
      decidedAt: '2026-10-20T00:02:08.000Z',
      decisionActor: 'demo-user',
    }),
  );

  const events = [
    ['demo-event-1', 'boss.selected', 'demo-boss', '2026-10-20T00:01:10.000Z'],
    ['demo-event-2', 'agents.discovered', 'demo-boss', '2026-10-20T00:01:30.000Z'],
    ['demo-event-3', 'task.delegated', 'demo-boss', '2026-10-20T00:02:10.000Z'],
    ['demo-event-4', 'worker.completed', 'demo-worker', '2026-10-20T00:05:00.000Z'],
    ['demo-event-5', 'boss.completed', 'demo-boss', '2026-10-20T00:06:00.000Z'],
  ] as const;
  for (const [id, type, actorId, occurredAt] of events) {
    repositories.events.append(
      AuditEventSchema.parse({
        id,
        projectId: project.id,
        type,
        actor: { type: 'agent', id: actorId },
        taskId: type === 'boss.selected' ? rootTask.id : childTask.id,
        payload: {},
        occurredAt,
      }),
    );
  }
}

export type AgentRuntimeStateProvider = (
  agentId: ReturnType<typeof AgentDefinitionSchema.parse>['id'],
) => {
  readiness: AgentReadiness;
  authMethods: AgentAuthMethodSummary[];
  negotiation?: AgentNegotiation;
  localEntry?: { offlineChecksPassed: boolean; issues: Array<{ code: string; message: string }> };
  error?: string | undefined;
};

export function readControlCenterSnapshot(
  storage: SqliteStorage,
  runtimeState?: AgentRuntimeStateProvider,
  bindingVersion?: (id: string) => string,
  approvalEligibility?: (
    approval: ReturnType<typeof ApprovalSchema.parse>,
  ) => ReturnType<typeof ApprovalDecisionEligibilitySchema.parse>,
  options?: ControlCenterReadOptions,
): ControlCenterSnapshot {
  const repositories = storage.repositories;
  const generatedAt = new Date().toISOString();
  const approvalRead = repositories.approvals.listWithDiagnostics();
  const tasks = repositories.tasks.list(),
    messages = repositories.messages.list();
  const messageStore = new SqliteMessageRouterStore(storage);
  const executionAttempts = repositories.executionAttempts.list();
  const projects = repositories.projects.list();
  const followUps =
    options?.view === 'conversation'
      ? projects.flatMap((project) =>
          repositories.events.listByProject(project.id, {
            taskIds: [],
            types: ['task.followup.created'],
          }),
        )
      : undefined;
  const taskIds = followUps
    ? [...conversationTaskIds({ tasks, timeline: followUps }, options?.taskId)]
    : [];
  const timeline = (
    followUps && !taskIds.length
      ? followUps
      : projects.flatMap((project) =>
          repositories.events.listByProject(
            project.id,
            followUps ? { taskIds, types: ['task.followup.created'] } : undefined,
          ),
        )
  ).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  return {
    generatedAt,
    projects,
    agents: repositories.agentDefinitions.list().map((definition) => ({
      definition,
      ...(runtimeState?.(definition.id) ?? {
        readiness: {
          runtime: 'unknown' as const,
          auth: 'unknown' as const,
          observedAt: generatedAt,
          authMethodIds: [],
        },
        authMethods: [],
      }),
    })),
    tasks,
    assignments: repositories.assignments.list(),
    executionAttempts,
    timeline,
    messages,
    messageDeliveries: messages.map((message) =>
      messageDeliveryView(
        message,
        messageStore.getDeliveryByMessage(message.id),
        tasks,
        generatedAt,
        executionAttempts,
      ),
    ),
    approvals: approvalRead.approvals.map((approval) =>
      ApprovalViewSchema.parse({
        ...approval,
        decisionEligibility: approvalEligibility?.(approval) ?? {
          canApprove: false,
          canReject: false,
          reason: 'runtime_unavailable',
          checkedAt: generatedAt,
          validForMs: 0,
        },
      }),
    ),
    approvalReadDiagnostics: approvalRead.diagnostics,
    artifacts: repositories.artifacts.list(),
    runners: repositories.runners.list(),
    workspaces: repositories.workspaces.list(),
    workspaceConfigs: repositories.projectWorkspaceConfigs.list(),
    assignmentWorkspaces: repositories.assignmentWorkspaces.list(),
    workspaceCleanups: repositories.workspaceCleanups.list(),
    directoryBindings: repositories.workspaceDirectoryBindings
      .list()
      .map(({ id, projectId, rootPath }) => ({
        id,
        projectId,
        rootPath,
        ...(bindingVersion ? { confirmationVersion: bindingVersion(id) } : {}),
      })),
  };
}
