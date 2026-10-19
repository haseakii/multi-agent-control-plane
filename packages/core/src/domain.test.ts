import { describe, expect, it } from 'vitest';
import {
  AgentDefinitionSchema,
  AgentIdSchema,
  ApprovalSchema,
  ArtifactSchema,
  AssignmentSchema,
  AuditEventSchema,
  BossAssignmentSchema,
  ConversationRefSchema,
  ProjectSchema,
  RunnerSchema,
  TaskSchema,
  WorkspaceSchema,
} from './domain.js';

const now = '2026-10-19T05:00:00Z';
const projectId = 'project-01';
const agentId = 'agent-01';
const taskId = 'task-01';
const assignmentId = 'assignment-01';
const runnerId = 'runner-01';

describe('core domain schemas', () => {
  it('keeps AgentDefinition provider-neutral and rejects a global role field', () => {
    const input = {
      id: agentId,
      name: 'Agent 01',
      enabled: true,
      runtime: {
        type: 'acp-stdio',
        command: 'agent-acp',
        args: [],
      },
      capabilities: [{ name: 'code.read', source: 'configured' }],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: true },
      controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
    } as const;

    expect(AgentDefinitionSchema.parse(input).id).toBe(agentId);
    expect(AgentDefinitionSchema.safeParse({ ...input, role: 'reviewer' }).success).toBe(false);
  });

  it('keeps Task and ConversationRef as distinct strict schemas', () => {
    const task = {
      id: taskId,
      projectId,
      title: 'Implement task engine',
      objective: 'Build durable state transitions',
      state: 'ready',
      dependencyIds: [],
      contextRefs: [],
      resultArtifactRefs: [],
      createdAt: now,
      updatedAt: now,
    } as const;

    const conversation = {
      id: 'conversation-01',
      taskId,
      assignmentId,
      agentId,
      runnerId,
      protocol: 'acp-v1',
      sessionId: 'session-01',
      createdAt: now,
    } as const;

    expect(TaskSchema.parse(task).id).toBe(taskId);
    expect(ConversationRefSchema.parse(conversation).sessionId).toBe('session-01');
    expect(TaskSchema.safeParse({ ...task, sessionId: 'session-01' }).success).toBe(false);
    expect(ConversationRefSchema.safeParse({ ...conversation, objective: 'not allowed' }).success).toBe(
      false,
    );
  });

  it('allows role semantics only on assignments', () => {
    const assignment = AssignmentSchema.parse({
      id: assignmentId,
      taskId,
      agentId,
      role: {
        name: 'Concurrency safety reviewer',
        description: 'Review lock ordering and race conditions.',
      },
      objective: 'Review the implementation',
      state: 'queued',
      attempt: 1,
      createdAt: now,
      updatedAt: now,
    });

    expect(assignment.role?.name).toBe('Concurrency safety reviewer');
  });

  it('validates representative project, governance, runner, artifact, and audit records', () => {
    expect(
      ProjectSchema.parse({
        id: projectId,
        name: 'Control Plane',
        createdAt: now,
        updatedAt: now,
      }).name,
    ).toBe('Control Plane');

    expect(
      BossAssignmentSchema.parse({
        id: 'boss-assignment-01',
        projectId,
        agentId,
        allowedOperations: ['agents.discover', 'tasks.delegate'],
        maxWorkers: 4,
        maxTaskDepth: 3,
        createdAt: now,
      }).maxWorkers,
    ).toBe(4);

    expect(
      RunnerSchema.parse({
        id: runnerId,
        kind: 'local',
        labels: ['linux'],
        capabilities: ['process.spawn'],
        status: 'ready',
      }).status,
    ).toBe('ready');

    expect(
      WorkspaceSchema.parse({
        id: 'workspace-01',
        projectId,
        runnerId,
        provider: 'local-directory',
        rootPath: '/workspace',
        access: 'read-write',
      }).provider,
    ).toBe('local-directory');

    expect(
      ArtifactSchema.parse({
        id: 'artifact-01',
        projectId,
        taskId,
        kind: 'report',
        sha256: 'a'.repeat(64),
        mimeType: 'text/markdown',
        sizeBytes: 12,
        storageKey: 'sha256/aa/example',
        createdAt: now,
      }).kind,
    ).toBe('report');

    expect(
      ApprovalSchema.parse({
        id: 'approval-01',
        projectId,
        taskId,
        requesterAgentId: agentId,
        action: 'git.push',
        resource: { branch: 'main' },
        enforcementMode: 'enforced',
        state: 'pending',
        requestedAt: now,
      }).state,
    ).toBe('pending');

    expect(
      AuditEventSchema.parse({
        id: 'event-01',
        projectId,
        type: 'task.created',
        actor: { type: 'agent', id: agentId },
        taskId,
        payload: { source: 'test' },
        occurredAt: now,
      }).type,
    ).toBe('task.created');

    expect(AgentIdSchema.safeParse('').success).toBe(false);
  });
});
