import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  // Register test-client as autonomous in DB so it explicitly holds approval privileges
  storage.repositories.externalClients.upsert({
    id: 'test-client',
    requestId: randomUUID(),
    requestHash: '0'.repeat(64),
    target: 'generic',
    profile: 'autonomous',
    createdAt: new Date().toISOString(),
    access: {
      id: 'test-client',
      name: 'External MCP Agent',
      enabled: true,
      tokenSha256,
      projects: [{ projectId: 'proj-a' }],
      tools: clientToolDefinitions.map((t) => t.name),
    },
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

  return { root, storage, runtime, app, call, token, service };
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
      rememberedRule: { key: 'workspaceFiles', value: 'task-scope:auto' },
    });
    expect(f.storage.repositories.approvals.get(appFile.id)?.state).toBe('approved');
    // Task-scoped rule is granted, project-wide policy is NOT mutated
    expect(f.runtime.getTaskScopePermissions('task-1').has('workspaceFiles')).toBe(true);
    expect(f.runtime.getProjectPolicy('proj-a').agentPermissions.workspaceFiles).toBe('ask');

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
    // Task-scoped rules granted for affected tasks; project policy remains ask
    expect(f.runtime.getTaskScopePermissions('task-1').has('commands')).toBe(true);
    expect(f.runtime.getTaskScopePermissions('task-2').has('commands')).toBe(true);
    expect(f.runtime.getProjectPolicy('proj-a').agentPermissions.commands).toBe('ask');

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

it('isolates autonomous client permissions without mutating project policy, and enforces approval boundaries', async () => {
  const f = createFixture();
  try {
    f.runtime.createProject({ id: 'proj-auto', name: 'Auto Project' });
    f.runtime.setWorkspaceMode('proj-auto', { mode: 'task-local' });
    expect(f.runtime.getProjectPolicy('proj-auto').agentPermissions.commands).toBe('ask');

    // 1. Create an autonomous client
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
    const autoCreated = res.json();
    const autoRecord = f.storage.repositories.externalClients.get(autoCreated.id)!;
    expect(autoRecord.profile).toBe('autonomous');

    // Invariant: Creating autonomous client does NOT mutate global project policy
    const policy = f.runtime.getProjectPolicy('proj-auto');
    expect(policy.agentPermissions.commands).toBe('ask');
    expect(policy.agentPermissions.workspaceFiles).toBe('ask');

    // Autonomous client receives approval tools in its grant list
    expect(autoRecord.access.tools).toContain('collaboration_decide_approval');
    expect(autoRecord.access.tools).toContain('collaboration_decide_all_approvals');

    const autoToken = JSON.parse(
      readFileSync(f.service.connectionFile(autoRecord.id), 'utf8'),
    ).token;

    // 2. Create a collaborate client
    const collabRes = await f.app.inject({
      method: 'POST',
      url: '/api/external-clients',
      payload: {
        requestId: randomUUID(),
        name: 'Collab Agent',
        target: 'vscode',
        profile: 'collaborate',
        projects: [{ projectId: 'proj-auto' }],
      },
    });
    expect(collabRes.statusCode).toBe(200);
    const collabCreated = collabRes.json();
    const collabRecord = f.storage.repositories.externalClients.get(collabCreated.id)!;
    expect(collabRecord.profile).toBe('collaborate');

    // Collaborate client does NOT have approval tools
    expect(collabRecord.access.tools).not.toContain('collaboration_decide_approval');
    expect(collabRecord.access.tools).not.toContain('collaboration_decide_all_approvals');

    const collabToken = JSON.parse(
      readFileSync(f.service.connectionFile(collabRecord.id), 'utf8'),
    ).token;

    // 3. Calling decide_approval with collaborate client token returns 403 Forbidden
    const collabAttempt = await f.call(
      'collaboration_decide_approval',
      { approvalId: 'any-approval-id', decision: 'approve' },
      collabToken,
    );
    expect(collabAttempt.statusCode).toBe(403);
    expect(collabAttempt.json().error).toContain('not authorized');

    // 4. Revoking the client immediately strips client authorization
    const revokeRes = await f.app.inject({
      method: 'POST',
      url: `/api/external-clients/${autoRecord.id}/revoke`,
      payload: {},
    });
    expect(revokeRes.statusCode).toBe(200);

    const afterRevoke = await f.call(
      'collaboration_decide_approval',
      { approvalId: 'any-approval-id', decision: 'approve' },
      autoToken,
    );
    expect(afterRevoke.statusCode).toBe(401);
  } finally {
    await f.app.close();
    await f.runtime.close();
    f.storage.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it('enforces zero residual authorization on approval rejection, failure, or unknown action (P0-02)', async () => {
  const f = createFixture();
  try {
    f.runtime.createProject({ id: 'proj-p02', name: 'P02 Project' });
    f.runtime.setWorkspaceMode('proj-p02', { mode: 'task-local' });

    // Authorize test-client for proj-p02
    const clientRec = f.storage.repositories.externalClients.get('test-client')!;
    f.storage.repositories.externalClients.upsert({
      ...clientRec,
      access: {
        ...clientRec.access,
        projects: [...clientRec.access.projects, { projectId: 'proj-p02' }],
      },
    });

    f.storage.repositories.tasks.upsert(
      TaskSchema.parse({
        id: 'task-p02',
        projectId: 'proj-p02',
        title: 'Task P02',
        objective: 'Test zero residual authorization',
        state: 'running',
        ownerAgentId: 'agent',
        dependencyIds: [],
        contextRefs: [],
        resultArtifactRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    const asgnP02 = AssignmentSchema.parse({
      id: 'asgn-p02',
      taskId: 'task-p02',
      agentId: 'agent',
      objective: 'Objective P02',
      attempt: 1,
      state: 'running',
      role: { name: 'Collaborator' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const attP02 = ExecutionAttemptSchema.parse({
      id: 'att-p02',
      taskId: 'task-p02',
      assignmentId: 'asgn-p02',
      number: 1,
      state: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    f.storage.repositories.assignments.upsert(asgnP02);
    f.storage.repositories.executionAttempts.upsert(attP02);

    const exec = {
      attempt: attP02,
      assignment: asgnP02,
      task: f.storage.repositories.tasks.get('task-p02')!,
      abort: new AbortController(),
      sessionId: 'sess-p02-1',
      acpRequest: undefined as any,
    };
    (f.runtime as any).active.set('task-p02', exec);

    // 1. Rejected approval with rememberRule: true MUST NOT grant any task-scoped permission
    const rejectApp = mockAcpApproval(
      'proj-p02',
      'task-p02',
      'process.execute',
      'bash',
      'git status',
      true,
      'sess-p02-1',
      'att-p02',
      'asgn-p02',
    );
    exec.sessionId = 'sess-p02-1';
    exec.acpRequest = {
      approvalId: rejectApp.id,
      signal: new AbortController().signal,
      binding: rejectApp.acp!,
    };
    f.storage.repositories.approvals.upsert(rejectApp);

    const rejectRes = await f.call('collaboration_decide_approval', {
      approvalId: rejectApp.id,
      decision: 'reject',
      rememberRule: true,
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().result.state).toBe('rejected');
    expect(f.runtime.getTaskScopePermissions('task-p02').size).toBe(0);

    // 2. Unknown action approval with rememberRule: true MUST NOT grant any task-scoped permission
    const unknownApp = mockAcpApproval(
      'proj-p02',
      'task-p02',
      'custom.unknown_action',
      'custom_tool',
      'custom_target',
      true,
      'sess-p02-2',
      'att-p02',
      'asgn-p02',
    );
    exec.sessionId = 'sess-p02-2';
    exec.acpRequest = {
      approvalId: unknownApp.id,
      signal: new AbortController().signal,
      binding: unknownApp.acp!,
    };
    f.storage.repositories.approvals.upsert(unknownApp);

    const unknownRes = await f.call('collaboration_decide_approval', {
      approvalId: unknownApp.id,
      decision: 'approve',
      rememberRule: true,
    });
    expect(unknownRes.statusCode).toBe(200);
    expect(unknownRes.json().result.rememberedRule).toBeNull();
    expect(f.runtime.getTaskScopePermissions('task-p02').size).toBe(0);

    // 3. Ineligible approval (missing info) with rememberRule: true returns 409 and leaves zero permissions
    const invalidApp = mockAcpApproval(
      'proj-p02',
      'task-p02',
      'process.execute',
      'bash',
      'git status',
      false, // complete: false -> missing_tool
      'sess-p02-3',
      'att-p02',
      'asgn-p02',
    );
    exec.sessionId = 'sess-p02-3';
    exec.acpRequest = {
      approvalId: invalidApp.id,
      signal: new AbortController().signal,
      binding: invalidApp.acp!,
    };
    f.storage.repositories.approvals.upsert(invalidApp);

    const invalidRes = await f.call('collaboration_decide_approval', {
      approvalId: invalidApp.id,
      decision: 'approve',
      rememberRule: true,
    });
    expect(invalidRes.statusCode).toBe(409);
    expect(f.runtime.getTaskScopePermissions('task-p02').size).toBe(0);
  } finally {
    await f.app.close();
    await f.runtime.close();
    f.storage.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it('enforces precise per-item batch scoping without cross-task permission spread (P0-04)', async () => {
  const f = createFixture();
  try {
    f.runtime.createProject({ id: 'proj-batch', name: 'Batch Project' });
    f.runtime.setWorkspaceMode('proj-batch', { mode: 'task-local' });

    // Authorize test-client for proj-batch
    const clientRec = f.storage.repositories.externalClients.get('test-client')!;
    f.storage.repositories.externalClients.upsert({
      ...clientRec,
      access: {
        ...clientRec.access,
        projects: [...clientRec.access.projects, { projectId: 'proj-batch' }],
      },
    });

    // Setup 4 distinct tasks with assignment & attempt
    for (const letter of ['a', 'b', 'c', 'd']) {
      const taskId = `task-${letter}`;
      const asgnId = `asgn-${letter}`;
      const attId = `att-${letter}`;
      f.storage.repositories.tasks.upsert(
        TaskSchema.parse({
          id: taskId,
          projectId: 'proj-batch',
          title: `Task ${taskId}`,
          objective: `Objective for ${taskId}`,
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
        id: asgnId,
        taskId,
        agentId: 'agent',
        objective: `Objective ${letter}`,
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
    }

    // Task A: process.execute -> should get ONLY commands
    const appA = mockAcpApproval(
      'proj-batch',
      'task-a',
      'process.execute',
      'bash',
      'git status',
      true,
      'sess-a',
      'att-a',
      'asgn-a',
    );
    // Task B: workspace.write -> should get ONLY workspaceFiles
    const appB = mockAcpApproval(
      'proj-batch',
      'task-b',
      'workspace.write',
      'write',
      'src/file.ts',
      true,
      'sess-b',
      'att-b',
      'asgn-b',
    );
    // Task C: unknown action -> should get ZERO rules
    const appC = mockAcpApproval(
      'proj-batch',
      'task-c',
      'acp.other',
      'custom_inspector',
      'workspace',
      true,
      'sess-c',
      'att-c',
      'asgn-c',
    );
    // Task D: invalid request (missing tool) -> should be SKIPPED, ZERO rules
    const appD = mockAcpApproval(
      'proj-batch',
      'task-d',
      'process.execute',
      'bash',
      'npm test',
      false, // invalid review
      'sess-d',
      'att-d',
      'asgn-d',
    );

    f.storage.repositories.approvals.upsert(appA);
    f.storage.repositories.approvals.upsert(appB);
    f.storage.repositories.approvals.upsert(appC);
    f.storage.repositories.approvals.upsert(appD);

    const execA = {
      attempt: f.storage.repositories.executionAttempts.get('att-a')!,
      assignment: f.storage.repositories.assignments.get('asgn-a')!,
      task: f.storage.repositories.tasks.get('task-a')!,
      abort: new AbortController(),
      sessionId: 'sess-a',
      acpRequest: { approvalId: appA.id, signal: new AbortController().signal, binding: appA.acp! },
    };
    const execB = {
      attempt: f.storage.repositories.executionAttempts.get('att-b')!,
      assignment: f.storage.repositories.assignments.get('asgn-b')!,
      task: f.storage.repositories.tasks.get('task-b')!,
      abort: new AbortController(),
      sessionId: 'sess-b',
      acpRequest: { approvalId: appB.id, signal: new AbortController().signal, binding: appB.acp! },
    };
    const execC = {
      attempt: f.storage.repositories.executionAttempts.get('att-c')!,
      assignment: f.storage.repositories.assignments.get('asgn-c')!,
      task: f.storage.repositories.tasks.get('task-c')!,
      abort: new AbortController(),
      sessionId: 'sess-c',
      acpRequest: { approvalId: appC.id, signal: new AbortController().signal, binding: appC.acp! },
    };
    const execD = {
      attempt: f.storage.repositories.executionAttempts.get('att-d')!,
      assignment: f.storage.repositories.assignments.get('asgn-d')!,
      task: f.storage.repositories.tasks.get('task-d')!,
      abort: new AbortController(),
      sessionId: 'sess-d',
      acpRequest: { approvalId: appD.id, signal: new AbortController().signal, binding: appD.acp! },
    };

    (f.runtime as any).active.set('task-a', execA);
    (f.runtime as any).active.set('task-b', execB);
    (f.runtime as any).active.set('task-c', execC);
    (f.runtime as any).active.set('task-d', execD);

    const batchRes = await f.call('collaboration_decide_all_approvals', {
      projectId: 'proj-batch',
      decision: 'approve',
      rememberRule: true,
    });
    expect(batchRes.statusCode).toBe(200);
    const body = batchRes.json().result;
    expect(body.decidedCount).toBe(3);
    expect(body.skippedCount).toBe(1);

    // Verify per-task isolation:
    // Task A has commands, NOT workspaceFiles
    const permsA = f.runtime.getTaskScopePermissions('task-a');
    expect(permsA.has('commands')).toBe(true);
    expect(permsA.has('workspaceFiles')).toBe(false);

    // Task B has workspaceFiles, NOT commands
    const permsB = f.runtime.getTaskScopePermissions('task-b');
    expect(permsB.has('workspaceFiles')).toBe(true);
    expect(permsB.has('commands')).toBe(false);

    // Task C has ZERO rules (unknown action never remembered)
    const permsC = f.runtime.getTaskScopePermissions('task-c');
    expect(permsC.size).toBe(0);

    // Task D was skipped, has ZERO rules
    const permsD = f.runtime.getTaskScopePermissions('task-d');
    expect(permsD.size).toBe(0);

    // Project global policies remain strictly 'ask'
    const policy = f.runtime.getProjectPolicy('proj-batch');
    expect(policy.agentPermissions.commands).toBe('ask');
    expect(policy.agentPermissions.workspaceFiles).toBe('ask');
  } finally {
    await f.app.close();
    await f.runtime.close();
    f.storage.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it('enforces task-scope lifecycle, terminal state deactivation, and sub-agent origin delegation (P1-01 & P1-02)', async () => {
  const f = createFixture();
  try {
    f.runtime.createProject({ id: 'proj-life', name: 'Lifecycle Project' });
    f.runtime.setWorkspaceMode('proj-life', { mode: 'task-local' });

    // 1. Root task and child task permission inheritance
    f.storage.repositories.tasks.upsert(
      TaskSchema.parse({
        id: 'task-parent',
        projectId: 'proj-life',
        title: 'Parent Task',
        objective: 'Parent Objective',
        state: 'running',
        ownerAgentId: 'boss-agent',
        dependencyIds: [],
        contextRefs: [],
        resultArtifactRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    f.storage.repositories.tasks.upsert(
      TaskSchema.parse({
        id: 'task-child-1',
        projectId: 'proj-life',
        parentTaskId: 'task-parent',
        title: 'Child Task 1',
        objective: 'Child Objective 1',
        state: 'running',
        ownerAgentId: 'sub-agent-1',
        dependencyIds: [],
        contextRefs: [],
        resultArtifactRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    // Grant commands to parent task
    f.runtime.grantTaskScopePermission('task-parent', 'commands', 'local-operator');
    // Child task inherits from active parent
    expect(f.runtime.getTaskScopePermissions('task-child-1').has('commands')).toBe(true);

    // When parent transitions to completed (terminal state), child ceases to inherit
    const parentTask = f.storage.repositories.tasks.get('task-parent')!;
    f.storage.repositories.tasks.upsert({ ...parentTask, state: 'completed' });

    expect(f.runtime.getTaskScopePermissions('task-parent').size).toBe(0);
    expect(f.runtime.getTaskScopePermissions('task-child-1').size).toBe(0);

    // 2. Multi-agent delegation origin tracing for autonomous client
    // Autonomous client submits task
    const autoClientRes = await f.app.inject({
      method: 'POST',
      url: '/api/external-clients',
      payload: {
        requestId: randomUUID(),
        name: 'Auto Origin Client',
        target: 'cursor',
        profile: 'autonomous',
        projects: [{ projectId: 'proj-life' }],
      },
    });
    const autoClient = autoClientRes.json();

    // Create a new task tree originating from this client
    f.storage.repositories.tasks.upsert(
      TaskSchema.parse({
        id: 'task-boss',
        projectId: 'proj-life',
        title: 'Boss Task',
        objective: 'Objective',
        state: 'running',
        ownerAgentId: 'boss-agent',
        dependencyIds: [],
        contextRefs: [],
        resultArtifactRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    // Record client.task.submitted for root task with actual agent actor
    f.storage.repositories.events.append({
      id: 'event-submit-' + randomUUID(),
      projectId: 'proj-life',
      taskId: 'task-boss',
      type: 'client.task.submitted',
      actor: { type: 'agent', id: `mcp-client:${autoClient.id}` },
      payload: { clientId: autoClient.id },
      occurredAt: new Date().toISOString(),
    });

    // Sub-agent task delegated by Boss
    f.storage.repositories.tasks.upsert(
      TaskSchema.parse({
        id: 'task-sub-agent',
        projectId: 'proj-life',
        parentTaskId: 'task-boss',
        title: 'Sub Task',
        objective: 'Sub Objective',
        state: 'running',
        ownerAgentId: 'sub-agent-a',
        dependencyIds: [],
        contextRefs: [],
        resultArtifactRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    // clientTaskOrigin correctly traces from task-sub-agent -> task-boss -> mcp-client:autoClient.id
    const origin = (f.runtime as any).clientTaskOrigin('task-sub-agent');
    expect(origin).toBe(`mcp-client:${autoClient.id}`);

    // If autoClient is revoked, clientTaskOrigin still finds the actor string,
    // but looking up the client record shows enabled = false, immediately removing autonomous privileges!
    await f.app.inject({
      method: 'POST',
      url: `/api/external-clients/${autoClient.id}/revoke`,
      payload: {},
    });
    const revokedRecord = f.storage.repositories.externalClients.get(autoClient.id)!;
    expect(revokedRecord.access.enabled).toBe(false);
  } finally {
    await f.app.close();
    await f.runtime.close();
    f.storage.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
