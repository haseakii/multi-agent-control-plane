import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDefinitionSchema, ApprovalSchema, ExecutionAttemptSchema } from '@control-plane/core';
import { openSqliteStorage } from '@control-plane/storage';
import { LocalRunner, type Runner, type ProcessHandle } from '@control-plane/runner';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlPlaneRuntime, requireCompletedAcpTurn } from './runtime-composition.js';
import { buildServer } from './server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function fixture(runner?: Runner) {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-composition-'));
  const storage = openSqliteStorage({ filename: join(directory, 'control-plane.sqlite') });
  const runtime = createControlPlaneRuntime({
    storage,
    ...(runner ? { runner } : {}),
    workspaceRoot: join(directory, 'workspaces'),
    artifactRoot: join(directory, 'artifacts'),
  });
  const app = buildServer({
    agentControl: runtime.agentControl,
    taskControl: runtime,
    fleetGateway: runtime.fleetGateway,
  });
  cleanup.push(async () => {
    await runtime.close();
    await app.close();
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { storage, runtime, app };
}

const boss = () =>
  AgentDefinitionSchema.parse({
    id: 'boss',
    name: 'Boss',
    enabled: true,
    runtime: { type: 'acp-stdio', command: '/missing-executable-for-test', args: [] },
    auth: { mode: 'agent-managed' },
    capabilities: [],
    orchestration: { canBeBoss: true },
    controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
  });

describe('production runtime application routes', () => {
  it('rejects excess goals and resumes before creating durable work', async () => {
    const runner = new LocalRunner();
    runner.spawn = async (spec) =>
      new Promise<ProcessHandle>((_resolve, reject) => {
        spec.signal?.addEventListener('abort', () => reject(new Error('Stopped test runner.')), {
          once: true,
        });
      });
    const { runtime, app, storage } = fixture(runner);
    runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
    runtime.createProject({ id: 'project', name: 'Capacity test' });
    runtime.agentControl.create(boss());
    runtime.agentControl.selectBoss('project', 'boss');
    for (let index = 0; index < 16; index++) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/projects/project/goals',
            payload: { objective: `Goal ${index}` },
          })
        ).statusCode,
      ).toBe(202);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects/project/goals',
          payload: { objective: 'Excess goal' },
        })
      ).statusCode,
    ).toBe(409);
    expect(storage.repositories.tasks.list()).toHaveLength(16);
    const task = runtime.taskEngine.createTask({
      id: 'retry-task',
      projectId: 'project',
      title: 'Retry',
      objective: 'Retry',
      state: 'ready',
    });
    const assignment = runtime.taskEngine.createAssignment({
      id: 'retry-assignment',
      taskId: task.id,
      agentId: 'boss',
      objective: 'Retry',
    });
    const attempt = runtime.taskEngine.createAttempt(assignment.id);
    runtime.taskEngine.startAttempt(attempt.id);
    runtime.taskEngine.finishAttempt(attempt.id, {
      outcome: 'failed',
      failure: { code: 'TEST', message: 'Test failure', retryable: true },
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/tasks/retry-task/resume' })).statusCode,
    ).toBe(409);
    expect(runtime.taskEngine.listAttempts(assignment.id)).toHaveLength(1);
  });
  it('does not treat cancellation, truncation, refusal, or unknown ACP stop reasons as success', () => {
    expect(() => requireCompletedAcpTurn('end_turn')).not.toThrow();
    for (const reason of ['cancelled', 'max_tokens', 'max_turn_requests', 'refusal', 'unknown']) {
      expect(() => requireCompletedAcpTurn(reason)).toThrow('本轮未完成');
    }
  });
  it('creates durable projects/workspaces and validates goal prerequisites without starting a process', async () => {
    const { app, storage, runtime } = fixture();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '', arbitrary: true },
    });
    expect(invalid.statusCode).toBe(400);
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { id: 'project', name: 'Example' },
    });
    expect(created.statusCode).toBe(201);
    expect(storage.repositories.workspaces.list()).toHaveLength(1);
    expect(storage.repositories.events.listByProject('project')[0]?.payload).toMatchObject({
      enforcementMode: 'unavailable',
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects',
          payload: { id: 'project', name: 'Duplicate' },
        })
      ).statusCode,
    ).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/projects/missing' })).statusCode).toBe(
      404,
    );
    runtime.setBridgeBaseUrl('http://127.0.0.1:4000');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects/project/goals',
          payload: { objective: 'A goal' },
        })
      ).statusCode,
    ).toBe(409);
    expect(storage.repositories.tasks.list()).toHaveLength(0);
    runtime.agentControl.create(boss());
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/projects/project/boss',
          payload: { agentId: 'boss' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects/project/goals',
          payload: { objective: '' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/tasks/missing/resume' })).statusCode,
    ).toBe(404);
  });

  it('persists approval decisions, validates requests, and refuses contradictory decisions', async () => {
    const { app, storage, runtime } = fixture();
    runtime.createProject({ id: 'project', name: 'Approval test' });
    storage.repositories.approvals.upsert(
      ApprovalSchema.parse({
        id: 'approval',
        projectId: 'project',
        action: 'workspace.read',
        resource: {},
        state: 'pending',
        enforcementMode: 'cooperative',
        boundary: 'control-plane-test',
        requestedAt: new Date().toISOString(),
      }),
    );
    expect(
      (await app.inject({ method: 'GET', url: '/api/approvals?state=pending' })).json(),
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/approvals/approval/approve',
          payload: { actor: '' },
        })
      ).statusCode,
    ).toBe(400);
    const approved = await app.inject({
      method: 'POST',
      url: '/api/approvals/approval/approve',
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      state: 'approved',
      decisionActor: 'local-user',
      enforcementMode: 'cooperative',
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/approvals/approval/reject', payload: {} }))
        .statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: '/api/approvals/missing/reject', payload: {} }))
        .statusCode,
    ).toBe(404);
  });

  it('recovers durable attempts without automatically replaying agent work or stale permissions', async () => {
    const { storage, runtime } = fixture();
    runtime.createProject({ id: 'project', name: 'Recovery' });
    runtime.agentControl.create(boss());
    runtime.taskEngine.createTask({
      id: 'task',
      projectId: 'project',
      title: 'Goal',
      objective: 'Goal',
      state: 'ready',
    });
    runtime.taskEngine.createAssignment({
      id: 'assignment',
      taskId: 'task',
      agentId: 'boss',
      objective: 'Goal',
    });
    const attempt = runtime.taskEngine.createAttempt('assignment');
    runtime.taskEngine.startAttempt(attempt.id);
    storage.repositories.approvals.upsert(
      ApprovalSchema.parse({
        id: 'approval',
        projectId: 'project',
        taskId: 'task',
        assignmentId: 'assignment',
        action: 'acp.tool',
        resource: {},
        state: 'pending',
        enforcementMode: 'cooperative',
        boundary: 'acp-permission',
        requestedAt: new Date().toISOString(),
      }),
    );
    const recovered = createControlPlaneRuntime({ storage });
    expect(
      ExecutionAttemptSchema.parse(storage.repositories.executionAttempts.get(attempt.id)).state,
    ).toBe('interrupted');
    expect(recovered.getTask('task').state).toBe('waiting');
    expect(recovered.listApprovals()[0]?.state).toBe('expired');
    await recovered.close();
  });
});
