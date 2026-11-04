import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { rememberableApprovalRule } from './approval-remember.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, describe, afterEach } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { clientToolDefinitions } from '@control-plane/fleet-mcp';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';
import { ExternalClientsService } from './external-clients.js';
import {
  TaskSchema,
  AssignmentSchema,
  ExecutionAttemptSchema,
  AuditEventSchema,
  AgentDefinitionSchema,
  ProjectSchema,
} from '@control-plane/core';

const tempDirs: string[] = [];
const openStorages: Array<{ close: () => void }> = [];

afterEach(() => {
  while (openStorages.length > 0) {
    try {
      openStorages.pop()?.close();
    } catch {}
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  }
});

function createRound4Fixture() {
  const root = mkdtempSync(join(tmpdir(), 'client-round4-'));
  tempDirs.push(root);
  const filename = join(root, 'state.sqlite');
  const storage = openSqliteStorage({ filename });
  openStorages.push(storage);

  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });

  const tokenA = 'a'.repeat(64);
  const tokenShaA = createHash('sha256').update(tokenA).digest('hex');
  const tokenB = 'b'.repeat(64);
  const tokenShaB = createHash('sha256').update(tokenB).digest('hex');

  const service = new ExternalClientsService({
    storage,
    runtime,
    baseUrl: 'http://127.0.0.1:0',
    readLegacy: () => ({ version: 1, clients: [] }),
  });

  // Project 1
  runtime.createProject({ id: 'proj-1', name: 'Project 1' });
  runtime.setWorkspaceMode('proj-1', { mode: 'task-local' });

  // Project 2
  runtime.createProject({ id: 'proj-2', name: 'Project 2' });
  runtime.setWorkspaceMode('proj-2', { mode: 'task-local' });

  // Default Agent
  storage.repositories.agentDefinitions.upsert(
    AgentDefinitionSchema.parse({
      id: 'worker',
      name: 'Worker Agent',
      enabled: true,
      runtime: { type: 'acp-stdio', command: 'worker-acp-fixture', args: [] },
      capabilities: [
        { name: 'code.read', source: 'verified' },
        { name: 'code.review', source: 'verified' },
      ],
      auth: { mode: 'agent-managed' },
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'none', scopes: [] },
    }),
  );

  // Client A: autonomous, authorized for proj-1 and proj-2
  storage.repositories.externalClients.upsert({
    id: 'client-a',
    revision: 1,
    requestId: randomUUID(),
    requestHash: '0'.repeat(64),
    target: 'generic',
    profile: 'autonomous',
    createdAt: new Date().toISOString(),
    access: {
      id: 'client-a',
      name: 'Client Alpha',
      enabled: true,
      tokenSha256: tokenShaA,
      projects: [{ projectId: 'proj-1' }, { projectId: 'proj-2' }],
      tools: clientToolDefinitions.map((t) => t.name),
    },
  });

  // Client B: collaborate, authorized for proj-1 only
  storage.repositories.externalClients.upsert({
    id: 'client-b',
    revision: 1,
    requestId: randomUUID(),
    requestHash: '0'.repeat(64),
    target: 'generic',
    profile: 'collaborate',
    createdAt: new Date().toISOString(),
    access: {
      id: 'client-b',
      name: 'Client Beta',
      enabled: true,
      tokenSha256: tokenShaB,
      projects: [{ projectId: 'proj-1' }],
      tools: clientToolDefinitions
        .filter(
          (t) =>
            !['collaboration_decide_approval', 'collaboration_decide_all_approvals'].includes(
              t.name,
            ),
        )
        .map((t) => t.name),
    },
  });

  const app = buildServer({
    taskControl: runtime,
    externalClients: service,
    clientGateway: { storage, runtime, readAccess: service.readAccess },
  });

  function seedTask(options: {
    id: string;
    projectId?: string;
    parentTaskId?: string;
    originClient?: string;
    state?: 'ready' | 'running' | 'completed' | 'failed' | 'cancelled';
  }) {
    const { id, projectId = 'proj-1', parentTaskId, originClient, state = 'running' } = options;

    storage.repositories.tasks.upsert(
      TaskSchema.parse({
        id,
        projectId,
        title: `Task ${id}`,
        objective: `Objective for ${id}`,
        state,
        parentTaskId,
        dependencyIds: [],
        contextRefs: [],
        resultArtifactRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    if (originClient) {
      storage.repositories.events.append(
        AuditEventSchema.parse({
          id: `submit-${id}`,
          projectId,
          taskId: id,
          type: 'client.task.submitted',
          actor: { type: 'agent', id: `mcp-client:${originClient}` },
          payload: { clientId: originClient, requestHash: '0'.repeat(64), executionMode: 'worker' },
          occurredAt: new Date().toISOString(),
        }),
      );
    }
  }

  function seedActiveExecution(taskId: string, sessionId = 'sess-1') {
    const asgnId = 'asgn-' + taskId;
    const attId = 'att-' + taskId;
    const asgn = AssignmentSchema.parse({
      id: asgnId,
      taskId,
      agentId: 'worker',
      objective: 'Obj',
      attempt: 1,
      state: 'running',
      role: { name: 'Collaborator' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const att = ExecutionAttemptSchema.parse({
      id: attId,
      taskId,
      assignmentId: asgnId,
      number: 1,
      state: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    storage.repositories.assignments.upsert(asgn);
    storage.repositories.executionAttempts.upsert(att);
    (runtime as any).active.set(taskId, {
      assignment: asgn,
      attempt: att,
      abort: new AbortController(),
      sessionId,
      acceptingMessages: true,
    });
  }

  return { root, storage, runtime, service, app, tokenA, tokenB, seedTask, seedActiveExecution };
}

describe('PR #47 Round 4 Security & Permission Fixes', () => {
  describe('P0-01: Cross-Client Task Control & Confused Deputy Prevention', () => {
    it('allows client to continue and cancel its own task', async () => {
      const { app, tokenA, seedTask, seedActiveExecution } = createRound4Fixture();
      seedTask({ id: 'task-a1', originClient: 'client-a', state: 'running' });
      seedActiveExecution('task-a1');

      // Client A continues its own task
      const continueRes = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          toolName: 'collaboration_continue_task',
          input: {
            taskId: 'task-a1',
            content: 'Follow-up instruction from Client A',
            idempotencyKey: 'key-1',
          },
        },
      });
      expect(continueRes.statusCode).toBe(200);

      // Client A cancels its own task
      const cancelRes = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          toolName: 'collaboration_cancel_task',
          input: { taskId: 'task-a1' },
        },
      });
      expect(cancelRes.statusCode).toBe(200);
    });

    it('allows client to control legally delegated child task', async () => {
      const { app, tokenA, seedTask, seedActiveExecution } = createRound4Fixture();
      seedTask({ id: 'task-root', originClient: 'client-a', state: 'running' });
      seedTask({ id: 'task-child', parentTaskId: 'task-root', state: 'running' });
      seedActiveExecution('task-child');

      // Client A continues the child task
      const continueRes = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          toolName: 'collaboration_continue_task',
          input: {
            taskId: 'task-child',
            content: 'Instruction to child task',
            idempotencyKey: 'key-child-1',
          },
        },
      });
      expect(continueRes.statusCode).toBe(200);

      // Client A cancels the child task
      const cancelRes = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          toolName: 'collaboration_cancel_task',
          input: { taskId: 'task-child' },
        },
      });
      expect(cancelRes.statusCode).toBe(200);
    });

    it('strictly forbids Client B from continuing Client A running task (Confused Deputy defense)', async () => {
      const { app, tokenB, seedTask } = createRound4Fixture();
      seedTask({ id: 'task-a-auto', originClient: 'client-a', state: 'running' });

      // Client B tries to inject instructions into Client A's task
      const res = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          toolName: 'collaboration_continue_task',
          input: {
            taskId: 'task-a-auto',
            content: 'Malicious instruction injected by Client B',
            idempotencyKey: 'attack-1',
          },
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain('无权向非本客户端发起的任务追加指令');
    });

    it('strictly forbids Client B from cancelling Client A task', async () => {
      const { app, tokenB, seedTask } = createRound4Fixture();
      seedTask({ id: 'task-a-running', originClient: 'client-a', state: 'running' });

      const res = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          toolName: 'collaboration_cancel_task',
          input: { taskId: 'task-a-running' },
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain('无权取消非本客户端发起的任务');
    });

    it('strictly forbids Client B from creating follow-up on Client A completed task', async () => {
      const { app, tokenB, seedTask } = createRound4Fixture();
      seedTask({ id: 'task-a-ended', originClient: 'client-a', state: 'completed' });

      const res = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          toolName: 'collaboration_continue_task',
          input: {
            taskId: 'task-a-ended',
            content: 'Follow-up attempt by Client B',
            idempotencyKey: 'followup-attack-1',
          },
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain('无权向非本客户端发起的任务追加指令');
    });

    it('strictly forbids Client B from controlling local operator task', async () => {
      const { app, tokenB, seedTask } = createRound4Fixture();
      // No originClient means created by local operator in workbench
      seedTask({ id: 'task-local', state: 'running' });

      const continueRes = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          toolName: 'collaboration_continue_task',
          input: {
            taskId: 'task-local',
            content: 'Instruction to local operator task',
            idempotencyKey: 'key-local-1',
          },
        },
      });
      expect(continueRes.statusCode).toBe(403);
      expect(continueRes.json().error).toContain('无权向非本客户端发起的任务追加指令');

      const cancelRes = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          toolName: 'collaboration_cancel_task',
          input: { taskId: 'task-local' },
        },
      });
      expect(cancelRes.statusCode).toBe(403);
      expect(cancelRes.json().error).toContain('无权取消非本客户端发起的任务');
    });

    it('rejects revoked client with 401 when attempting task control', async () => {
      const { app, service, tokenA, seedTask } = createRound4Fixture();
      seedTask({ id: 'task-a-old', originClient: 'client-a', state: 'running' });

      // Revoke Client A
      service.revoke('client-a');

      const res = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          toolName: 'collaboration_continue_task',
          input: {
            taskId: 'task-a-old',
            content: 'Attempt after revocation',
            idempotencyKey: 'key-revoked-1',
          },
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects cross-project task control with 403', async () => {
      const { app, tokenB, seedTask } = createRound4Fixture();
      // Task is in proj-2, but Client B only has access to proj-1
      seedTask({ id: 'task-p2', projectId: 'proj-2', originClient: 'client-b', state: 'running' });

      const res = await app.inject({
        method: 'POST',
        url: '/internal/client/tool',
        headers: { authorization: `Bearer ${tokenB}` },
        payload: {
          toolName: 'collaboration_continue_task',
          input: {
            taskId: 'task-p2',
            content: 'Cross project continue attempt',
            idempotencyKey: 'key-p2-1',
          },
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('P1-01: Multi-Actor Task-Scoped Grant Independence', () => {
    it('stores independent grants for different actors and maintains idempotency per actor', () => {
      const { runtime, seedTask } = createRound4Fixture();
      seedTask({ id: 'task-t1', originClient: 'client-a', state: 'running' });

      // Client A grants commands
      runtime.grantTaskScopePermission('task-t1', 'commands', 'mcp-client:client-a');

      // Local operator also grants commands on the same task
      runtime.grantTaskScopePermission('task-t1', 'commands', 'local-operator');

      // Idempotency check: Local operator repeats grant -> should not duplicate
      runtime.grantTaskScopePermission('task-t1', 'commands', 'local-operator');

      const grants = (runtime as any)
        .taskScopeGrants('proj-1')
        .filter((g: any) => g.taskId === 'task-t1');
      expect(grants).toBeDefined();
      expect(grants.length).toBe(2);
      expect(
        grants.filter((g: any) => g.actor === 'mcp-client:client-a' && g.rule === 'commands')
          .length,
      ).toBe(1);
      expect(
        grants.filter((g: any) => g.actor === 'local-operator' && g.rule === 'commands').length,
      ).toBe(1);
    });

    it('preserves local operator grant when Client A is revoked', () => {
      const { runtime, service, seedTask } = createRound4Fixture();
      seedTask({ id: 'task-t2', originClient: 'client-a', state: 'running' });

      // Both Client A and Local Operator grant commands
      runtime.grantTaskScopePermission('task-t2', 'commands', 'mcp-client:client-a');
      runtime.grantTaskScopePermission('task-t2', 'commands', 'local-operator');

      expect(runtime.getTaskScopePermissions('task-t2').has('commands')).toBe(true);

      // Revoke Client A
      service.revoke('client-a');

      // Local operator's grant remains valid!
      const activePermissions = runtime.getTaskScopePermissions('task-t2');
      expect(activePermissions.has('commands')).toBe(true);
    });

    it('preserves Client B grant when Client A is revoked', () => {
      const { runtime, storage, service, seedTask } = createRound4Fixture();
      seedTask({ id: 'task-t3', originClient: 'client-a', state: 'running' });

      // Upgrade Client B to autonomous for this test
      const rowB = storage.repositories.externalClients.get('client-b')!;
      storage.repositories.externalClients.upsert({
        ...rowB,
        profile: 'autonomous',
      });

      // Both Client A and Client B grant commands
      runtime.grantTaskScopePermission('task-t3', 'commands', 'mcp-client:client-a');
      runtime.grantTaskScopePermission('task-t3', 'commands', 'mcp-client:client-b');

      // Revoke Client A
      service.revoke('client-a');

      // Client B's grant remains active!
      const activePermissions = runtime.getTaskScopePermissions('task-t3');
      expect(activePermissions.has('commands')).toBe(true);
    });

    it('returns empty permissions once all actor grants are revoked', () => {
      const { runtime, seedTask } = createRound4Fixture();
      seedTask({ id: 'task-t4', originClient: 'client-a', state: 'running' });

      runtime.grantTaskScopePermission('task-t4', 'commands', 'mcp-client:client-a');
      runtime.grantTaskScopePermission('task-t4', 'commands', 'local-operator');

      runtime.revokeTaskScopePermissions('task-t4');

      const activePermissions = runtime.getTaskScopePermissions('task-t4');
      expect(activePermissions.has('commands')).toBe(false);
    });
  });

  describe('P2-02: Grant Revocation Audit Completeness', () => {
    it('emits task.scope.revoked with project_access_removed when client project access is removed', () => {
      const { runtime, service, storage, seedTask } = createRound4Fixture();
      seedTask({
        id: 'task-audit-1',
        projectId: 'proj-1',
        originClient: 'client-a',
        state: 'running',
      });

      runtime.grantTaskScopePermission('task-audit-1', 'commands', 'mcp-client:client-a');

      // Remove proj-1 from client-a
      service.updateGrants('client-a', {
        expectedRevision: 1,
        requestId: randomUUID(),
        projects: [{ projectId: 'proj-2' }],
        profile: 'autonomous',
      });

      const events = runtime
        .projectEvents('proj-1')
        .filter((e) => e.taskId === 'task-audit-1' && e.type === 'task.scope.revoked');

      expect(events.length).toBe(1);
      expect(events[0]!.payload).toMatchObject({
        taskId: 'task-audit-1',
        rule: 'commands',
        actor: 'mcp-client:client-a',
        reason: 'project_access_removed',
      });
    });

    it('emits task.scope.revoked with client_demoted when client profile is demoted to collaborate', () => {
      const { runtime, service, seedTask } = createRound4Fixture();
      seedTask({
        id: 'task-audit-2',
        projectId: 'proj-1',
        originClient: 'client-a',
        state: 'running',
      });

      runtime.grantTaskScopePermission('task-audit-2', 'commands', 'mcp-client:client-a');

      // Demote client-a to collaborate
      service.updateGrants('client-a', {
        expectedRevision: 1,
        requestId: randomUUID(),
        projects: [{ projectId: 'proj-1' }, { projectId: 'proj-2' }],
        profile: 'collaborate',
      });

      const events = runtime
        .projectEvents('proj-1')
        .filter((e) => e.taskId === 'task-audit-2' && e.type === 'task.scope.revoked');

      expect(events.length).toBe(1);
      expect(events[0]!.payload).toMatchObject({
        taskId: 'task-audit-2',
        rule: 'commands',
        actor: 'mcp-client:client-a',
        reason: 'client_demoted',
      });
    });

    it('emits dynamic invalidation audit on getTaskScopePermissions without duplicates on repeat queries', () => {
      const { runtime, storage, seedTask } = createRound4Fixture();
      seedTask({
        id: 'task-audit-3',
        projectId: 'proj-1',
        originClient: 'client-a',
        state: 'running',
      });

      runtime.grantTaskScopePermission('task-audit-3', 'commands', 'mcp-client:client-a');

      // Directly disable client-a in database without calling service
      const clientA = storage.repositories.externalClients.get('client-a')!;
      storage.repositories.externalClients.upsert({
        ...clientA,
        access: { ...clientA.access, enabled: false },
      });

      // First query: dynamically detects disabled client and invalidates
      const perms1 = runtime.getTaskScopePermissions('task-audit-3');
      expect(perms1.has('commands')).toBe(false);

      const events1 = runtime
        .projectEvents('proj-1')
        .filter((e) => e.taskId === 'task-audit-3' && e.type === 'task.scope.revoked');
      expect(events1.length).toBe(1);
      expect(events1[0]!.payload).toMatchObject({
        reason: 'client_disabled_or_missing',
      });

      // Second query: does NOT emit duplicate audit event
      const perms2 = runtime.getTaskScopePermissions('task-audit-3');
      expect(perms2.has('commands')).toBe(false);

      const events2 = runtime
        .projectEvents('proj-1')
        .filter((e) => e.taskId === 'task-audit-3' && e.type === 'task.scope.revoked');
      expect(events2.length).toBe(1);
    });
  });
});

describe('PR #47 review regressions', () => {
  it('keeps locally created follow-ups and their children outside the earlier client identity', async () => {
    const { runtime, storage, app, tokenA, seedTask, seedActiveExecution } = createRound4Fixture();
    seedTask({ id: 'external-root', originClient: 'client-a', state: 'completed' });
    seedTask({ id: 'local-followup', originClient: 'client-a', state: 'running' }); // legacy copied submit event
    storage.repositories.events.append({
      id: 'local-followup-created',
      projectId: 'proj-1',
      taskId: 'local-followup',
      type: 'task.followup.created',
      actor: { type: 'user', id: 'local-operator' },
      payload: { sourceTaskId: 'external-root' },
      occurredAt: new Date().toISOString(),
    });
    seedTask({ id: 'local-child', parentTaskId: 'local-followup' });
    seedActiveExecution('local-followup');
    expect(runtime.clientTaskOrigin('local-followup')).toBeUndefined();
    expect(runtime.clientTaskOrigin('local-child')).toBeUndefined();
    const response = await app.inject({
      method: 'POST',
      url: '/internal/client/tool',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        toolName: 'collaboration_continue_task',
        input: { taskId: 'local-followup', content: 'inject', idempotencyKey: 'local-check' },
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('recovers independent grants and revocations across database reopen without trusting old unversioned events', () => {
    const { root, storage, runtime, seedTask } = createRound4Fixture();
    seedTask({ id: 'persist-task', originClient: 'client-a' });
    runtime.grantTaskScopePermission('persist-task', 'commands', 'mcp-client:client-a');
    runtime.grantTaskScopePermission('persist-task', 'commands', 'local-operator');
    runtime.revokeTaskScopeGrantsForClient('client-a');
    storage.repositories.events.append({
      id: 'old-unsafe-grant',
      projectId: 'proj-1',
      taskId: 'persist-task',
      type: 'task.scope.granted',
      actor: { type: 'system', id: 'runtime-composition' },
      payload: { taskId: 'persist-task', rule: 'workspaceFiles', actor: 'local-operator' },
      occurredAt: new Date().toISOString(),
    });
    storage.close();
    const reopened = openSqliteStorage({ filename: join(root, 'state.sqlite') });
    openStorages.push(reopened);
    const restored = createControlPlaneRuntime({
      storage: reopened,
      workspaceRoot: join(root, 'workspaces'),
      artifactRoot: join(root, 'artifacts'),
    });
    expect([...restored.getTaskScopePermissions('persist-task')]).toEqual(['commands']);
    restored.revokeTaskScopePermissions('persist-task');
    expect(restored.getTaskScopePermissions('persist-task').size).toBe(0);
    const again = createControlPlaneRuntime({
      storage: reopened,
      workspaceRoot: join(root, 'workspaces'),
      artifactRoot: join(root, 'artifacts'),
    });
    expect(again.getTaskScopePermissions('persist-task').size).toBe(0);
  });

  it('does not grant a remembered workspace rule when an outside file is approved', async () => {
    const { root, storage, runtime, app, tokenA, seedTask, seedActiveExecution } =
      createRound4Fixture();
    seedTask({ id: 'outside-task', originClient: 'client-a' });
    seedActiveExecution('outside-task');
    const work = join(root, 'isolated');
    mkdirSync(work);
    storage.repositories.workspaces.upsert({
      id: 'isolated-w',
      projectId: 'proj-1',
      provider: 'local-directory',
      rootPath: work,
      access: 'read-write',
    });
    storage.repositories.assignmentWorkspaces.upsert({
      id: 'asgn-outside-task',
      projectId: 'proj-1',
      taskId: 'outside-task',
      workspaceId: 'isolated-w',
      sourceWorkspaceId: 'isolated-w',
      mode: 'task-local',
      createdAt: new Date().toISOString(),
    });
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const binding = {
      version: 1,
      attemptId: 'att-outside-task',
      attemptNumber: 1,
      sessionId: 'sha256:' + createHash('sha256').update('sess-1').digest('hex'),
      toolCallId: 'sha256:' + '1'.repeat(64),
      requestId: randomUUID(),
      expiresAt,
      review: {
        version: 1,
        status: 'complete',
        tool: 'edit_file',
        action: 'file.write',
        target: join(root, 'outside.txt'),
        parameters: { resolved: { fileOperation: 'write' } },
        provenance: {},
        presence: {},
        reasons: [],
        historyUsed: false,
        observedAt: new Date().toISOString(),
        expiresAt,
      },
    };
    storage.repositories.approvals.upsert({
      id: 'outside-approval',
      projectId: 'proj-1',
      taskId: 'outside-task',
      assignmentId: 'asgn-outside-task',
      requesterAgentId: 'worker',
      action: 'acp.tool',
      resource: { review: binding.review },
      enforcementMode: 'cooperative',
      boundary: 'acp-permission',
      state: 'pending',
      requestedAt: new Date().toISOString(),
      acp: binding,
    });
    (runtime as any).active.get('outside-task').acpRequest = {
      approvalId: 'outside-approval',
      signal: new AbortController().signal,
      binding,
    };
    const listed = await app.inject({
      method: 'POST',
      url: '/internal/client/tool',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { toolName: 'collaboration_list_approvals', input: { projectId: 'proj-1' } },
    });
    expect(listed.json().result.approvals[0].rememberRuleEligible).toBe(false);
    const decided = await app.inject({
      method: 'POST',
      url: '/internal/client/tool',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        toolName: 'collaboration_decide_approval',
        input: { approvalId: 'outside-approval', decision: 'approve', rememberRule: true },
      },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().result.rememberedRule).toBeNull();
    expect(runtime.getTaskScopePermissions('outside-task').size).toBe(0);
  });

  it('replays scope changes in append order and rolls back failed transactions', () => {
    const { runtime, storage, seedTask } = createRound4Fixture();
    seedTask({ id: 'ordered-task' });
    const event = {
      projectId: 'proj-1',
      taskId: 'ordered-task',
      actor: { type: 'system', id: 'runtime-composition' },
      payload: { version: 1, taskId: 'ordered-task', rule: 'commands', actor: 'local-operator' },
    };
    storage.repositories.events.append({
      ...event,
      id: 'scope-grant-future',
      type: 'task.scope.granted',
      occurredAt: '2030-01-01T00:00:00.000Z',
    });
    storage.repositories.events.append({
      ...event,
      id: 'scope-revoke-past',
      type: 'task.scope.revoked',
      occurredAt: '2020-01-01T00:00:00.000Z',
    });
    expect(runtime.getTaskScopePermissions('ordered-task').size).toBe(0);
    expect(() =>
      storage.repositories.transaction(() => {
        runtime.grantTaskScopePermission('ordered-task', 'commands');
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(runtime.getTaskScopePermissions('ordered-task').size).toBe(0);
  });

  it('only remembers file approvals inside the bound isolated workspace', () => {
    const { root, storage, seedTask, seedActiveExecution } = createRound4Fixture();
    seedTask({ id: 'file-task' });
    seedActiveExecution('file-task');
    const work = join(root, 'actual-workspace');
    mkdirSync(work);
    storage.repositories.workspaces.upsert({
      id: 'w',
      projectId: 'proj-1',
      provider: 'local-directory',
      rootPath: work,
      access: 'read-write',
    });
    storage.repositories.assignmentWorkspaces.upsert({
      id: 'asgn-file-task',
      projectId: 'proj-1',
      taskId: 'file-task',
      workspaceId: 'w',
      sourceWorkspaceId: 'w',
      mode: 'task-local',
      createdAt: new Date().toISOString(),
    });
    const approval = {
      projectId: 'proj-1',
      taskId: 'file-task',
      assignmentId: 'asgn-file-task',
      action: 'acp.tool',
      boundary: 'acp-permission',
      acp: {
        review: {
          status: 'complete',
          reasons: [],
          action: 'file.write',
          tool: 'edit_file',
          target: join(work, 'file.txt'),
          parameters: { resolved: { fileOperation: 'write' } },
        },
      },
    } as any;
    expect(rememberableApprovalRule(storage, approval)).toBe('workspaceFiles');
    approval.acp.review.target = join(root, 'outside.txt');
    expect(rememberableApprovalRule(storage, approval)).toBeUndefined();
    approval.acp.review.target = join(work, '.env');
    expect(rememberableApprovalRule(storage, approval)).toBeUndefined();
    approval.assignmentId = 'missing';
    expect(rememberableApprovalRule(storage, approval)).toBeUndefined();
  });
});
