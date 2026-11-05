import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, describe, afterEach } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { clientToolDefinitions } from '@control-plane/fleet-mcp';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';
import { ExternalClientsService } from './external-clients.js';
import type { AcpApprovalBinding, Approval } from '@control-plane/core';
import {
  TaskSchema,
  AssignmentSchema,
  ExecutionAttemptSchema,
  AuditEventSchema,
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

function createMultiClientFixture() {
  const root = mkdtempSync(join(tmpdir(), 'client-round3-'));
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

  // Client A: autonomous
  storage.repositories.externalClients.upsert({
    id: 'client-a',
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

  // Client B: autonomous
  storage.repositories.externalClients.upsert({
    id: 'client-b',
    requestId: randomUUID(),
    requestHash: '0'.repeat(64),
    target: 'generic',
    profile: 'autonomous',
    createdAt: new Date().toISOString(),
    access: {
      id: 'client-b',
      name: 'Client Beta',
      enabled: true,
      tokenSha256: tokenShaB,
      projects: [{ projectId: 'proj-1' }],
      tools: clientToolDefinitions.map((t) => t.name),
    },
  });

  const app = buildServer({
    taskControl: runtime,
    externalClients: service,
    clientGateway: { storage, runtime, readAccess: service.readAccess },
  });

  const callAs = (clientId: 'client-a' | 'client-b', toolName: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: '/internal/client/tool',
      headers: { authorization: 'Bearer ' + (clientId === 'client-a' ? tokenA : tokenB) },
      payload: { toolName, input },
    });

  return { root, storage, runtime, app, service, callAs, tokenA, tokenB };
}

function mockApproval(
  projectId: string,
  taskId?: string,
  action = 'process.execute',
  tool = 'bash',
  target = 'ls -la',
): Approval {
  const id = 'app-' + randomUUID().slice(0, 8);
  const asgnId = taskId ? 'asgn-' + taskId : 'asgn-1';
  const attId = taskId ? 'att-' + taskId : 'att-1';
  const sessionHash = 'sha256:' + createHash('sha256').update('sess-1').digest('hex');
  const binding: AcpApprovalBinding = {
    version: 1,
    attemptId: attId as any,
    attemptNumber: 1,
    sessionId: sessionHash,
    toolCallId: 'sha256:' + '1'.repeat(64),
    requestId: randomUUID(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    review: {
      version: 1,
      status: 'complete',
      tool,
      action,
      target,
      parameters: { resolved: { command: target } },
      provenance: {},
      presence: {},
      reasons: [],
      historyUsed: false,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  };
  return {
    id: id as any,
    projectId: projectId as any,
    ...(taskId ? { taskId: taskId as any } : {}),
    assignmentId: asgnId as any,
    requesterAgentId: 'worker' as any,
    action: 'acp.tool',
    resource: { review: binding.review },
    enforcementMode: 'cooperative',
    boundary: 'acp-permission',
    state: 'pending',
    requestedAt: new Date().toISOString(),
    acp: binding,
  };
}

function seedOrigin(
  f: ReturnType<typeof createMultiClientFixture>,
  taskId: string,
  projectId: string,
  actorId: string,
) {
  f.storage.repositories.events.append(
    AuditEventSchema.parse({
      id: 'event-' + taskId + '-' + randomUUID().slice(0, 6),
      projectId,
      taskId,
      type: 'client.task.submitted',
      actor: { type: 'agent', id: actorId },
      payload: {
        clientId: actorId.replace('mcp-client:', ''),
        requestHash: '0'.repeat(64),
        executionMode: 'worker',
      },
      occurredAt: new Date().toISOString(),
    }),
  );
}

function seedActiveExecution(
  f: ReturnType<typeof createMultiClientFixture>,
  taskId: string,
  approval: Approval,
  sessionId = 'sess-1',
) {
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
  f.storage.repositories.assignments.upsert(asgn);
  f.storage.repositories.executionAttempts.upsert(att);
  (f.runtime as any).active.set(taskId, {
    assignment: asgn,
    attempt: att,
    abort: new AbortController(),
    sessionId,
    acpRequest: {
      approvalId: approval.id,
      signal: new AbortController().signal,
      binding: approval.acp,
    },
  });
}

function seedTask(
  f: ReturnType<typeof createMultiClientFixture>,
  id: string,
  projectId: string,
  parentTaskId?: string,
) {
  f.storage.repositories.tasks.upsert(
    TaskSchema.parse({
      id,
      projectId,
      parentTaskId,
      title: 'Task ' + id,
      objective: 'Objective ' + id,
      state: 'running',
      ownerAgentId: 'worker',
      dependencyIds: [],
      contextRefs: [],
      resultArtifactRefs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

describe('P0-01: Invalidation of task-scoped auto permissions on client revocation / demotion', () => {
  it('invalidates task-scoped commands permission when originating client is revoked', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      seedTask(f, 'task-t1', 'proj-1');
      seedOrigin(f, 'task-t1', 'proj-1', 'mcp-client:client-a');

      // Client A grants commands permission to task-t1
      f.runtime.grantTaskScopePermission('task-t1', 'commands', 'mcp-client:client-a');
      expect(f.runtime.getTaskScopePermissions('task-t1').has('commands')).toBe(true);

      // Revoke Client A
      const revokeRes = await f.app.inject({
        method: 'POST',
        url: '/api/external-clients/client-a/revoke',
        payload: {},
      });
      expect(revokeRes.statusCode).toBe(200);

      // Task-scoped grant must now be immediately invalid!
      expect(f.runtime.getTaskScopePermissions('task-t1').has('commands')).toBe(false);
      expect(f.runtime.getTaskScopePermissions('task-t1').size).toBe(0);
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('invalidates autonomous privileges when client is demoted to collaborate', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      seedTask(f, 'task-demote', 'proj-1');
      seedOrigin(f, 'task-demote', 'proj-1', 'mcp-client:client-a');

      f.runtime.grantTaskScopePermission('task-demote', 'commands', 'mcp-client:client-a');
      expect(f.runtime.getTaskScopePermissions('task-demote').has('commands')).toBe(true);

      // Demote Client A to collaborate
      const client = f.storage.repositories.externalClients.get('client-a')!;
      f.storage.repositories.externalClients.upsert({
        ...client,
        profile: 'collaborate',
      });

      // getTaskScopePermissions must re-validate profile and invalidate commands grant
      expect(f.runtime.getTaskScopePermissions('task-demote').has('commands')).toBe(false);
      expect(f.runtime.getTaskScopePermissions('task-demote').size).toBe(0);
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('invalidates task-scoped permission when client project authorization is removed', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      f.runtime.createProject({ id: 'proj-2', name: 'Proj 2' });
      seedTask(f, 'task-proj1', 'proj-1');
      seedOrigin(f, 'task-proj1', 'proj-1', 'mcp-client:client-a');

      f.runtime.grantTaskScopePermission('task-proj1', 'commands', 'mcp-client:client-a');
      expect(f.runtime.getTaskScopePermissions('task-proj1').has('commands')).toBe(true);

      // Remove proj-1 authorization from Client A
      const client = f.storage.repositories.externalClients.get('client-a')!;
      f.storage.repositories.externalClients.upsert({
        ...client,
        access: {
          ...client.access,
          projects: [{ projectId: 'proj-2' }], // Only proj-2 retained
        },
      });

      // Grant on proj-1 must be invalidated
      expect(f.runtime.getTaskScopePermissions('task-proj1').has('commands')).toBe(false);
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('invalidates child task inherited permissions when ancestor origin client is revoked', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      seedTask(f, 'task-parent', 'proj-1');
      seedOrigin(f, 'task-parent', 'proj-1', 'mcp-client:client-a');
      seedTask(f, 'task-child', 'proj-1', 'task-parent');

      f.runtime.grantTaskScopePermission('task-parent', 'commands', 'mcp-client:client-a');
      // Child inherits parent's grant
      expect(f.runtime.getTaskScopePermissions('task-child').has('commands')).toBe(true);

      // Revoke client A
      await f.app.inject({
        method: 'POST',
        url: '/api/external-clients/client-a/revoke',
        payload: {},
      });

      // Child task must lose the inherited grant
      expect(f.runtime.getTaskScopePermissions('task-child').has('commands')).toBe(false);
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('keeps Client B grants active when Client A is revoked (isolation)', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      seedTask(f, 'task-a', 'proj-1');
      seedOrigin(f, 'task-a', 'proj-1', 'mcp-client:client-a');
      seedTask(f, 'task-b', 'proj-1');
      seedOrigin(f, 'task-b', 'proj-1', 'mcp-client:client-b');

      f.runtime.grantTaskScopePermission('task-a', 'commands', 'mcp-client:client-a');
      f.runtime.grantTaskScopePermission('task-b', 'commands', 'mcp-client:client-b');

      expect(f.runtime.getTaskScopePermissions('task-a').has('commands')).toBe(true);
      expect(f.runtime.getTaskScopePermissions('task-b').has('commands')).toBe(true);

      // Revoke Client A only
      await f.app.inject({
        method: 'POST',
        url: '/api/external-clients/client-a/revoke',
        payload: {},
      });

      // Client A grant is invalidated
      expect(f.runtime.getTaskScopePermissions('task-a').has('commands')).toBe(false);
      // Client B grant is completely unaffected!
      expect(f.runtime.getTaskScopePermissions('task-b').has('commands')).toBe(true);
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('never revokes local operator grants when client is revoked', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      seedTask(f, 'task-local', 'proj-1');

      f.runtime.grantTaskScopePermission('task-local', 'commands', 'local-operator');
      expect(f.runtime.getTaskScopePermissions('task-local').has('commands')).toBe(true);

      // Revoke Client A
      await f.app.inject({
        method: 'POST',
        url: '/api/external-clients/client-a/revoke',
        payload: {},
      });

      // Local operator grant MUST remain valid
      expect(f.runtime.getTaskScopePermissions('task-local').has('commands')).toBe(true);
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('does not restore invalidated client authorization after runtime restart', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      seedTask(f, 'task-restart', 'proj-1');
      seedOrigin(f, 'task-restart', 'proj-1', 'mcp-client:client-a');

      f.runtime.grantTaskScopePermission('task-restart', 'commands', 'mcp-client:client-a');
      expect(f.runtime.getTaskScopePermissions('task-restart').has('commands')).toBe(true);

      // Revoke Client A in database
      await f.app.inject({
        method: 'POST',
        url: '/api/external-clients/client-a/revoke',
        payload: {},
      });
      expect(f.runtime.getTaskScopePermissions('task-restart').has('commands')).toBe(false);

      // Close and restart runtime
      await f.app.close();
      await f.runtime.close();
      f.storage.close();

      const reopenedStorage = openSqliteStorage({ filename: join(f.root, 'state.sqlite') });
      openStorages.push(reopenedStorage);
      const newRuntime = createControlPlaneRuntime({
        storage: reopenedStorage,
        workspaceRoot: join(f.root, 'workspaces'),
        artifactRoot: join(f.root, 'artifacts'),
      });

      // After restart, revoked client grants must NOT be revived!
      expect(newRuntime.getTaskScopePermissions('task-restart').has('commands')).toBe(false);
      // Attempting to grant with revoked client fails validation
      newRuntime.grantTaskScopePermission('task-restart', 'commands', 'mcp-client:client-a');
      expect(newRuntime.getTaskScopePermissions('task-restart').has('commands')).toBe(false);
      await newRuntime.close();
    } finally {
      // Cleaned up by afterEach
    }
  });
});

describe('P0-02: Strictly restrict autonomous client approval scope', () => {
  it('allows client to approve approvals for its own task and delegated child task', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      seedTask(f, 'task-own', 'proj-1');
      seedOrigin(f, 'task-own', 'proj-1', 'mcp-client:client-a');
      seedTask(f, 'task-child', 'proj-1', 'task-own');

      const appOwn = mockApproval('proj-1', 'task-own');
      const appChild = mockApproval('proj-1', 'task-child');
      f.storage.repositories.approvals.upsert(appOwn);
      f.storage.repositories.approvals.upsert(appChild);
      seedActiveExecution(f, 'task-own', appOwn);
      seedActiveExecution(f, 'task-child', appChild);

      // Client A approves own task approval -> 200
      const resOwn = await f.callAs('client-a', 'collaboration_decide_approval', {
        approvalId: appOwn.id,
        decision: 'approve',
      });
      expect(resOwn.statusCode).toBe(200);
      expect(resOwn.json().result.state).toBe('approved');

      // Client A approves child task approval -> 200
      const resChild = await f.callAs('client-a', 'collaboration_decide_approval', {
        approvalId: appChild.id,
        decision: 'approve',
      });
      expect(resChild.statusCode).toBe(200);
      expect(resChild.json().result.state).toBe('approved');
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('strictly blocks Client A from deciding approvals for Client B task', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      seedTask(f, 'task-b', 'proj-1');
      seedOrigin(f, 'task-b', 'proj-1', 'mcp-client:client-b');

      const appB = mockApproval('proj-1', 'task-b');
      f.storage.repositories.approvals.upsert(appB);

      // Client A attempts to approve Client B's task approval -> 403 Forbidden!
      const res = await f.callAs('client-a', 'collaboration_decide_approval', {
        approvalId: appB.id,
        decision: 'approve',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain('无权审批非本客户端发起的任务请求');

      // Approval remains pending
      expect(f.storage.repositories.approvals.get(appB.id)?.state).toBe('pending');
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('strictly blocks Client A from deciding approvals for local operator task', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      seedTask(f, 'task-local', 'proj-1');
      // No client origin: this is a local operator / boss task!

      const appLocal = mockApproval('proj-1', 'task-local');
      f.storage.repositories.approvals.upsert(appLocal);

      // Client A attempts to approve local operator task -> 403 Forbidden!
      const res = await f.callAs('client-a', 'collaboration_decide_approval', {
        approvalId: appLocal.id,
        decision: 'approve',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain('无权审批非本客户端发起的任务请求');
      expect(f.storage.repositories.approvals.get(appLocal.id)?.state).toBe('pending');
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('excludes other clients approvals during batch approval', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });

      // Client A tasks
      seedTask(f, 'task-a1', 'proj-1');
      seedOrigin(f, 'task-a1', 'proj-1', 'mcp-client:client-a');
      seedTask(f, 'task-a2', 'proj-1');
      seedOrigin(f, 'task-a2', 'proj-1', 'mcp-client:client-a');

      // Client B tasks
      seedTask(f, 'task-b1', 'proj-1');
      seedOrigin(f, 'task-b1', 'proj-1', 'mcp-client:client-b');
      seedTask(f, 'task-b2', 'proj-1');
      seedOrigin(f, 'task-b2', 'proj-1', 'mcp-client:client-b');

      const appA1 = mockApproval('proj-1', 'task-a1');
      const appA2 = mockApproval('proj-1', 'task-a2');
      const appB1 = mockApproval('proj-1', 'task-b1');
      const appB2 = mockApproval('proj-1', 'task-b2');

      f.storage.repositories.approvals.upsert(appA1);
      f.storage.repositories.approvals.upsert(appA2);
      f.storage.repositories.approvals.upsert(appB1);
      f.storage.repositories.approvals.upsert(appB2);
      seedActiveExecution(f, 'task-a1', appA1);
      seedActiveExecution(f, 'task-a2', appA2);

      // Client A runs batch approve in proj-1
      const res = await f.callAs('client-a', 'collaboration_decide_all_approvals', {
        projectId: 'proj-1',
        decision: 'approve',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json().result;
      // Client A must only see and decide its own 2 approvals!
      expect(body.totalPending).toBe(2);
      expect(body.decidedCount).toBe(2);
      expect(body.decided.map((d: any) => d.approvalId).sort()).toEqual(
        [appA1.id, appA2.id].sort(),
      );

      // Client B's approvals must remain PENDING and untouched!
      expect(f.storage.repositories.approvals.get(appB1.id)?.state).toBe('pending');
      expect(f.storage.repositories.approvals.get(appB2.id)?.state).toBe('pending');
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('isolates approval listing between clients in the same project', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      seedTask(f, 'task-a', 'proj-1');
      seedOrigin(f, 'task-a', 'proj-1', 'mcp-client:client-a');
      seedTask(f, 'task-b', 'proj-1');
      seedOrigin(f, 'task-b', 'proj-1', 'mcp-client:client-b');

      const appA = mockApproval('proj-1', 'task-a');
      const appB = mockApproval('proj-1', 'task-b');
      f.storage.repositories.approvals.upsert(appA);
      f.storage.repositories.approvals.upsert(appB);

      // Client A lists approvals
      const resA = await f.callAs('client-a', 'collaboration_list_approvals', {
        projectId: 'proj-1',
      });
      expect(resA.statusCode).toBe(200);
      expect(resA.json().result.total).toBe(1);
      expect(resA.json().result.approvals[0].id).toBe(appA.id);

      // Client B lists approvals
      const resB = await f.callAs('client-b', 'collaboration_list_approvals', {
        projectId: 'proj-1',
      });
      expect(resB.statusCode).toBe(200);
      expect(resB.json().result.total).toBe(1);
      expect(resB.json().result.approvals[0].id).toBe(appB.id);
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('rejects approval without bound taskId from external client decision', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      // Approval with undefined taskId
      const unboundApp = mockApproval('proj-1');
      f.storage.repositories.approvals.upsert(unboundApp);

      const res = await f.callAs('client-a', 'collaboration_decide_approval', {
        approvalId: unboundApp.id,
        decision: 'approve',
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain('无权审批未绑定明确任务上下文的确认请求');
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });

  it('immediately blocks approval tool execution after client is revoked or demoted', async () => {
    const f = createMultiClientFixture();
    try {
      f.runtime.createProject({ id: 'proj-1', name: 'Proj 1' });
      seedTask(f, 'task-a', 'proj-1');
      seedOrigin(f, 'task-a', 'proj-1', 'mcp-client:client-a');

      const appA = mockApproval('proj-1', 'task-a');
      f.storage.repositories.approvals.upsert(appA);

      // Case 1: Demoting Client A to collaborate blocks decide_approval with 403 Forbidden
      const client = f.storage.repositories.externalClients.get('client-a')!;
      f.storage.repositories.externalClients.upsert({
        ...client,
        profile: 'collaborate',
      });

      const resDemoted = await f.callAs('client-a', 'collaboration_decide_approval', {
        approvalId: appA.id,
        decision: 'approve',
      });
      expect(resDemoted.statusCode).toBe(403);

      // Case 2: Revoking Client A completely denies token access with 401
      await f.app.inject({
        method: 'POST',
        url: '/api/external-clients/client-a/revoke',
        payload: {},
      });

      const resRevoked = await f.callAs('client-a', 'collaboration_decide_approval', {
        approvalId: appA.id,
        decision: 'approve',
      });
      expect(resRevoked.statusCode).toBe(401);
    } finally {
      await f.app.close();
      await f.runtime.close();
    }
  });
});
