import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ApprovalSchema, AuditEventSchema, TaskSchema } from '@control-plane/core';
import { clientToolDefinitions } from '@control-plane/fleet-mcp';
import { openSqliteStorage } from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'client-recovery-'));
  const storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  runtime.createProject({ id: 'p', name: 'Shared' });
  runtime.createProject({ id: 'private', name: 'Private' });
  const token = 'c'.repeat(64);
  const client = {
    id: 'reader',
    name: 'Recovery reader',
    enabled: true,
    tokenSha256: createHash('sha256').update(token).digest('hex'),
    projects: [{ projectId: 'p' }],
    tools: clientToolDefinitions.map((tool) => tool.name),
  };
  const app = buildServer({
    taskControl: runtime,
    clientGateway: { storage, runtime, readAccess: () => ({ version: 1, clients: [client] }) },
  });
  const at = '2026-01-01T00:00:00.000Z';
  const task = (id: string, state = 'running', projectId = 'p', parentTaskId?: string) => {
    const value = TaskSchema.parse({
      id,
      projectId,
      title: id,
      objective: 'Read-only recovery fixture',
      state,
      ...(parentTaskId ? { parentTaskId } : {}),
      dependencyIds: [],
      contextRefs: [],
      resultArtifactRefs: [],
      createdAt: at,
      updatedAt: at,
    });
    storage.repositories.tasks.upsert(value);
    return value;
  };
  const approval = (taskId: string, projectId = 'p') => {
    const value = ApprovalSchema.parse({
      id: 'approval-' + taskId,
      projectId,
      taskId,
      action: 'file.write',
      resource: { path: 'example.txt' },
      enforcementMode: 'cooperative',
      state: 'pending',
      requestedAt: at,
    });
    storage.repositories.approvals.upsert(value);
    return value;
  };
  const event = (id: string, taskId: string, type = 'agent.progress', payload = {}) =>
    storage.repositories.events.append(
      AuditEventSchema.parse({
        id,
        projectId: 'p',
        taskId,
        type,
        payload,
        actor: { type: 'system', id: 'fixture' },
        occurredAt: at,
      }),
    );
  const call = (taskId: string, options = {}) =>
    app.inject({
      method: 'POST',
      url: '/internal/client/tool',
      headers: { authorization: 'Bearer ' + token },
      payload: { toolName: 'collaboration_get_task', input: { taskId, ...options } },
    });
  return {
    storage,
    runtime,
    app,
    client,
    task,
    approval,
    event,
    call,
    async close() {
      await app.close();
      await runtime.close();
      storage.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('returns read-only diagnostics without refreshing activity', async () => {
  const f = fixture();
  try {
    const original = f.task('done', 'completed');
    const first = await f.call(original.id);
    expect(first.statusCode, first.body).toBe(200);
    const firstResult = first.json().result;
    expect(firstResult.recovery).toMatchObject({
      latestTaskId: 'done',
      contextPreserved: true,
      diagnostic: {
        reason: 'execution_completed',
        nextAction: 'verify_outputs',
        automaticRetryAllowed: false,
      },
    });
    const second = (await f.call(original.id)).json().result;
    expect(second.recovery.diagnostic.lastActivityAt).toBe(
      firstResult.recovery.diagnostic.lastActivityAt,
    );
    expect(f.storage.repositories.tasks.get(original.id)).toEqual(original);
    expect(f.storage.repositories.executionAttempts.list()).toHaveLength(0);
    expect(f.storage.repositories.assignments.list()).toHaveLength(0);
    expect(f.storage.repositories.approvals.list()).toHaveLength(0);
    expect(f.runtime.taskExecutionActive(original.id)).toBe(false);
    expect((await f.call(f.task('secret', 'failed', 'private').id)).statusCode).toBe(403);
  } finally {
    await f.close();
  }
});

it.each(['running', 'failed', 'completed'] as const)(
  'returns the same web and MCP diagnosis for %s with pending code review',
  async (state) => {
    const f = fixture();
    try {
      f.task('task', state);
      const original = f.approval('task');
      f.storage.repositories.approvals.upsert({ ...original, action: 'git.merge' });
      vi.spyOn(f.runtime, 'taskExecutionActive').mockReturnValue(state === 'running');
      const mcp = (await f.call('task')).json().result.recovery;
      const response = await f.app.inject({ method: 'GET', url: '/api/tasks/task/recovery' });
      expect(response.statusCode).toBe(200);
      const web = response.json();
      for (const key of [
        'reason',
        'title',
        'message',
        'pendingApprovals',
        'nextAction',
        'actionOwner',
        'executionActive',
        'automaticRetryAllowed',
        'lastActivityAt',
      ])
        expect(web.diagnostic[key]).toEqual(mcp.diagnostic[key]);
      expect(web.latestTaskId).toBe(mcp.latestTaskId);
      expect(web.diagnostic.reason).toBe(
        state === 'running'
          ? 'executing'
          : state === 'failed'
            ? 'execution_failed'
            : 'execution_completed',
      );
      expect(web.diagnostic.pendingApprovals).toEqual({ execution: 0, review: 1, push: 0 });
      expect(f.storage.repositories.approvals.get(original.id)?.state).toBe('pending');
      expect(f.storage.repositories.executionAttempts.list()).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
);

it('reports only same-project subtree approvals without deciding them', async () => {
  const f = fixture();
  try {
    f.task('parent', 'waiting');
    f.task('child', 'waiting_approval', 'p', 'parent');
    f.task('unrelated', 'waiting_approval');
    f.task('private-task', 'waiting_approval', 'private');
    const pending = f.approval('child');
    f.approval('unrelated');
    f.approval('private-task', 'private');
    const response = await f.call('parent');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().result.recovery.diagnostic).toMatchObject({
      reason: 'waiting_approval',
      actionOwner: 'operator',
      pendingApprovalCount: 1,
      automaticRetryAllowed: false,
    });
    expect(response.json().result.pendingApprovals.map((a: { id: string }) => a.id)).toEqual([
      pending.id,
    ]);
    expect(f.storage.repositories.approvals.get(pending.id)).toEqual(pending);
  } finally {
    await f.close();
  }
});

it('refreshes children and newer rounds created during a long poll', async () => {
  const f = fixture();
  try {
    f.task('parent');
    f.event('initial', 'parent');
    await f.app.ready();
    const reads = vi.spyOn(f.runtime, 'projectEvents');
    const responsePromise = f.call('parent', { after: 'initial', waitMs: 2000 });
    await expect.poll(() => reads.mock.calls.length).toBeGreaterThan(0);
    f.task('child', 'waiting_approval', 'p', 'parent');
    f.approval('child');
    f.event('child-progress', 'child');
    f.task('next', 'ready');
    f.event('followup', 'next', 'task.followup.created', { sourceTaskId: 'parent' });
    const response = await responsePromise;
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json().result;
    expect(result.recovery).toMatchObject({
      latestTaskId: 'next',
      diagnostic: { reason: 'newer_round_available', pendingApprovalCount: 1 },
    });
    expect(result.children.map((t: { id: string }) => t.id)).toContain('child');
    expect(result.events.map((e: { id: string }) => e.id)).toContain('child-progress');
    expect(result.nextTaskId).toBe('next');
  } finally {
    await f.close();
  }
});

it('revalidates revoked access before returning diagnostics after a long poll', async () => {
  const f = fixture();
  try {
    f.task('parent');
    f.event('initial', 'parent');
    await f.app.ready();
    const reads = vi.spyOn(f.runtime, 'projectEvents');
    const responsePromise = f.call('parent', { after: 'initial', waitMs: 2000 });
    await expect.poll(() => reads.mock.calls.length).toBeGreaterThan(0);
    f.client.enabled = false;
    f.event('wake', 'parent');
    const response = await responsePromise;
    expect(response.statusCode).toBe(403);
    expect(response.json()).not.toHaveProperty('result');
  } finally {
    await f.close();
  }
});
