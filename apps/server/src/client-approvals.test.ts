import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openSqliteStorage } from '@control-plane/storage';
import { clientToolDefinitions } from '@control-plane/fleet-mcp';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';
import { ExternalClientsService } from './external-clients.js';
import type { AcpApprovalBinding, Approval } from '@control-plane/core';
import { TaskSchema, AssignmentSchema, ExecutionAttemptSchema } from '@control-plane/core';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'client-approvals-')),
    filename = join(root, 'state.sqlite');
  const storage = openSqliteStorage({ filename });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  const token = 'c'.repeat(64);
  const tokenSha256 = createHash('sha256').update(token).digest('hex');
  const service = new ExternalClientsService({
    storage,
    runtime,
    baseUrl: 'http://127.0.0.1:8057',
    localHost: { root, runtime: process.execPath, entry: join(root, 'control-plane.mjs') },
    readLegacy: () => ({
      version: 1,
      clients: [
        {
          id: 'test-client',
          name: 'External MCP Agent',
          enabled: true,
          tokenSha256,
          projects: [{ projectId: 'proj-a' }],
          tools: clientToolDefinitions.map((t) => t.name),
        },
      ],
    }),
  });
  const app = buildServer({
    taskControl: runtime,
    externalClients: service,
    clientGateway: { storage, runtime, readAccess: service.readAccess },
  });

  const call = (toolName: string, input: unknown, bearer = token) =>
    app.inject({
      method: 'POST',
      url: '/internal/client/tool',
      headers: { authorization: 'Bearer ' + bearer },
      payload: { toolName, input },
    });

  return { root, storage, runtime, app, call, token };
}

function mockAcpApproval(
  projectId: string,
  taskId: string,
  action: string,
  tool: string,
  target: string,
  complete = true,
  sessionId = 'sess-1',
  attemptId = 'att-1',
  assignmentId = 'asgn-1',
): Approval {
  const id = 'approval-' + randomUUID();
  const sessionHash = 'sha256:' + createHash('sha256').update(sessionId).digest('hex');
  const binding: AcpApprovalBinding = {
    version: 1,
    attemptId: attemptId as any,
    attemptNumber: 1,
    sessionId: sessionHash,
    toolCallId: 'sha256:' + '1'.repeat(64),
    requestId: randomUUID(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    review: {
      version: 1,
      status: complete ? 'complete' : 'invalid',
      tool,
      action,
      target,
      parameters: {},
      provenance: {},
      presence: {},
      reasons: complete ? [] : ['missing_tool'],
      historyUsed: false,
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  };

  return {
    id: id as any,
    projectId: projectId as any,
    taskId: taskId as any,
    assignmentId: assignmentId as any,
    requesterAgentId: 'agent' as any,
    action: 'acp.tool',
    resource: { review: binding.review },
    enforcementMode: 'cooperative',
    boundary: 'acp-permission',
    state: 'pending',
    requestedAt: new Date().toISOString(),
    acp: binding,
  };
}

it('allows external MCP clients to list, inspect, decide individually, and batch approve pending requests', async () => {
  const f = createFixture();
  try {
    f.runtime.createProject({ id: 'proj-a', name: 'Project Alpha' });
    f.runtime.createProject({ id: 'proj-b', name: 'Project Beta' });
    f.storage.repositories.tasks.upsert(
      TaskSchema.parse({
        id: 'task-1',
        projectId: 'proj-a',
        title: 'Task 1',
        objective: 'Task 1 objective',
        state: 'running',
        ownerAgentId: 'agent',
        dependencyIds: [],
        contextRefs: [],
        resultArtifactRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    f.storage.repositories.tasks.upsert(
      TaskSchema.parse({
        id: 'task-2',
        projectId: 'proj-a',
        title: 'Task 2',
        objective: 'Task 2 objective',
        state: 'running',
        ownerAgentId: 'agent',
        dependencyIds: [],
        contextRefs: [],
        resultArtifactRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    const asgn = AssignmentSchema.parse({
      id: 'asgn-1',
      taskId: 'task-1',
      agentId: 'agent',
      objective: 'Objective 1',
      attempt: 1,
      state: 'running',
      role: { name: 'Collaborator' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const att = ExecutionAttemptSchema.parse({
      id: 'att-1',
      taskId: 'task-1',
      assignmentId: 'asgn-1',
      number: 1,
      state: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    f.storage.repositories.assignments.upsert(asgn);
    f.storage.repositories.executionAttempts.upsert(att);

    const asgn2 = AssignmentSchema.parse({
      id: 'asgn-2',
      taskId: 'task-2',
      agentId: 'agent',
      objective: 'Objective 2',
      attempt: 1,
      state: 'running',
      role: { name: 'Collaborator' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const att2 = ExecutionAttemptSchema.parse({
      id: 'att-2',
      taskId: 'task-2',
      assignmentId: 'asgn-2',
      number: 1,
      state: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    f.storage.repositories.assignments.upsert(asgn2);
    f.storage.repositories.executionAttempts.upsert(att2);

    // Seed 3 approvals for proj-a
    const appCmd = mockAcpApproval(
      'proj-a',
      'task-1',
      'process.execute',
      'bash',
      'npm test',
      true,
      'sess-1',
    );
    const appFile = mockAcpApproval(
      'proj-a',
      'task-1',
      'workspace.write',
      'write',
      'src/app.ts',
      true,
      'sess-1',
    );
    const appInvalid = mockAcpApproval(
      'proj-a',
      'task-2',
      'process.execute',
      'bash',
      'rm -rf /',
      false,
      'sess-2',
      'att-2',
      'asgn-2',
    );

    const exec1 = {
      assignment: asgn,
      attempt: att,
      abort: new AbortController(),
      sessionId: 'sess-1',
      acpRequest: {
        approvalId: appCmd.id,
        signal: new AbortController().signal,
        binding: appCmd.acp,
      },
    };
    const exec2 = {
      assignment: asgn2,
      attempt: att2,
      abort: new AbortController(),
      sessionId: 'sess-2',
      acpRequest: {
        approvalId: appInvalid.id,
        signal: new AbortController().signal,
        binding: appInvalid.acp,
      },
    };
    (f.runtime as any).active.set('task-1', exec1);
    (f.runtime as any).active.set('task-2', exec2);

    f.storage.repositories.approvals.upsert(appCmd);
    f.storage.repositories.approvals.upsert(appFile);
    f.storage.repositories.approvals.upsert(appInvalid);

    // 1. List approvals
    const listRes = await f.call('collaboration_list_approvals', { projectId: 'proj-a' });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json().result;
    expect(listBody.total).toBe(3);
    expect(listBody.pendingCount).toBe(3);
    expect(listBody.approvals).toHaveLength(3);

    const cmdItem = listBody.approvals.find((a: any) => a.id === appCmd.id);
    expect(cmdItem).toMatchObject({
      action: 'acp.tool',
      tool: 'bash',
      target: 'npm test',
      decisionEligibility: { canApprove: true, canReject: true },
      rememberRuleEligible: true,
      rememberRuleSettingKey: 'commands',
    });

    const invalidItem = listBody.approvals.find((a: any) => a.id === appInvalid.id);
    expect(invalidItem.decisionEligibility.canApprove).toBe(false);
    expect(invalidItem.decisionEligibility.canReject).toBe(true);

    // Filter by taskId
    const task1List = await f.call('collaboration_list_approvals', {
      projectId: 'proj-a',
      taskId: 'task-1',
    });
    expect(task1List.json().result.total).toBe(2);

    // Reject unauthorized project
    const unauth = await f.call('collaboration_list_approvals', { projectId: 'proj-b' });
    expect(unauth.statusCode).toBe(403);

    // 2. Reject an individual approval
    const rejectRes = await f.call('collaboration_decide_approval', {
      approvalId: appCmd.id,
      decision: 'reject',
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().result).toMatchObject({
      approvalId: appCmd.id,
      decision: 'rejected',
      state: 'rejected',
    });
    expect(f.storage.repositories.approvals.get(appCmd.id)?.state).toBe('rejected');

    // 3. Approve an individual approval with rememberRule
    exec1.acpRequest = {
      approvalId: appFile.id,
      signal: new AbortController().signal,
      binding: appFile.acp!,
    };
    const approveRes = await f.call('collaboration_decide_approval', {
      approvalId: appFile.id,
      decision: 'approve',
      rememberRule: true,
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().result).toMatchObject({
      approvalId: appFile.id,
      decision: 'approved',
      state: 'approved',
      rememberedRule: { key: 'workspaceFiles', value: 'auto' },
    });
    expect(f.storage.repositories.approvals.get(appFile.id)?.state).toBe('approved');
    expect(f.runtime.getProjectPolicy('proj-a').agentPermissions.workspaceFiles).toBe('auto');

    // 4. Ineligible approval rejection vs approval attempt
    const cantApprove = await f.call('collaboration_decide_approval', {
      approvalId: appInvalid.id,
      decision: 'approve',
    });
    expect(cantApprove.statusCode).toBe(409);
    expect(cantApprove.json().error).toContain('无法批准');

    // Rejecting it succeeds
    const rejectInvalid = await f.call('collaboration_decide_approval', {
      approvalId: appInvalid.id,
      decision: 'reject',
    });
    expect(rejectInvalid.statusCode).toBe(200);
    expect(rejectInvalid.json().result.state).toBe('rejected');

    // 5. Batch approve (collaboration_decide_all_approvals)
    const batch1 = mockAcpApproval(
      'proj-a',
      'task-1',
      'process.execute',
      'bash',
      'git status',
      true,
      'sess-1',
    );
    const batch2 = mockAcpApproval(
      'proj-a',
      'task-2',
      'process.execute',
      'bash',
      'ls -la',
      true,
      'sess-2',
      'att-2',
      'asgn-2',
    );
    exec1.acpRequest = {
      approvalId: batch1.id,
      signal: new AbortController().signal,
      binding: batch1.acp!,
    };
    exec2.acpRequest = {
      approvalId: batch2.id,
      signal: new AbortController().signal,
      binding: batch2.acp!,
    };
    f.storage.repositories.approvals.upsert(batch1);
    f.storage.repositories.approvals.upsert(batch2);

    const batchRes = await f.call('collaboration_decide_all_approvals', {
      projectId: 'proj-a',
      decision: 'approve',
      rememberRule: true,
    });
    expect(batchRes.statusCode).toBe(200);
    const batchBody = batchRes.json().result;
    expect(batchBody.decidedCount).toBe(2);
    expect(batchBody.skippedCount).toBe(0);
    expect(batchBody.rememberedRules).toEqual(['commands']);
    expect(f.storage.repositories.approvals.get(batch1.id)?.state).toBe('approved');
    expect(f.storage.repositories.approvals.get(batch2.id)?.state).toBe('approved');
    expect(f.runtime.getProjectPolicy('proj-a').agentPermissions.commands).toBe('auto');

    // Calling decide_all when empty returns clean summary
    const emptyBatch = await f.call('collaboration_decide_all_approvals', {
      projectId: 'proj-a',
      decision: 'approve',
    });
    expect(emptyBatch.statusCode).toBe(200);
    expect(emptyBatch.json().result.summary).toBe('当前没有待处理的确认请求。');

    // Verify events were audited with mcp-client actor
    const events = f.storage.repositories.events.listByProject('proj-a');
    const clientToolEvents = events.filter((e) => e.type === 'client.tool.called');
    expect(clientToolEvents.length).toBeGreaterThan(0);
    expect(clientToolEvents[0]?.actor).toEqual({ type: 'agent', id: 'mcp-client:test-client' });
  } finally {
    await f.app.close();
    await f.runtime.close();
    f.storage.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it('configures autonomous external clients that automatically approve execution permissions without manual prompts', async () => {
  const f = createFixture();
  try {
    f.runtime.createProject({ id: 'proj-auto', name: 'Auto Project' });
    f.runtime.setWorkspaceMode('proj-auto', { mode: 'task-local' });
    expect(f.runtime.getProjectPolicy('proj-auto').agentPermissions.commands).toBe('ask');

    const res = await f.app.inject({
      method: 'POST',
      url: '/api/external-clients',
      payload: {
        requestId: randomUUID(),
        name: 'Auto Agent',
        target: 'cursor',
        profile: 'autonomous',
        projects: [{ projectId: 'proj-auto' }],
      },
    });
    expect(res.statusCode).toBe(200);

    const policy = f.runtime.getProjectPolicy('proj-auto');
    expect(policy.agentPermissions.commands).toBe('auto');
    expect(policy.agentPermissions.workspaceFiles).toBe('auto');
  } finally {
    await f.app.close();
    await f.runtime.close();
    f.storage.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
