import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ProcessAgentRuntimeControl } from '@control-plane/acp-runtime';
import { TaskSchema, type SessionSettingsSnapshot } from '@control-plane/core';
import { clientToolDefinitions } from '@control-plane/fleet-mcp';
import { openSqliteStorage } from '@control-plane/storage';
import { createControlPlaneRuntime } from './runtime-composition.js';
import { buildServer } from './server.js';

const settings: SessionSettingsSnapshot = {
  source: 'config-options',
  options: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'test-model',
      options: [{ value: 'test-model', name: 'Test model' }],
    },
  ],
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-settings-api-'));
  const storage = openSqliteStorage({ filename: join(root, 'state.sqlite') });
  const runtime = createControlPlaneRuntime({
    storage,
    workspaceRoot: join(root, 'workspaces'),
    artifactRoot: join(root, 'artifacts'),
  });
  runtime.createProject({ id: 'p', name: 'Shared' });
  runtime.createProject({ id: 'private', name: 'Private' });
  runtime.agentControl.create({
    id: 'agent',
    name: 'Test agent',
    enabled: true,
    runtime: { type: 'acp-stdio', command: process.execPath, args: [] },
    auth: { mode: 'agent-managed' },
    capabilities: [],
    orchestration: { canBeBoss: false },
    controlBridge: { transport: 'none', scopes: [] },
  });
  const token = 'e'.repeat(64);
  const access = {
    version: 1,
    clients: [
      {
        id: 'reader',
        name: 'Settings reader',
        enabled: true,
        tokenSha256: createHash('sha256').update(token).digest('hex'),
        projects: [{ projectId: 'p' }],
        tools: clientToolDefinitions.map((tool) => tool.name),
      },
    ],
  };
  const app = buildServer({
    taskControl: runtime,
    clientGateway: { storage, runtime, readAccess: () => access },
  });
  const call = (toolName: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: '/internal/client/tool',
      headers: { authorization: 'Bearer ' + token },
      payload: { toolName, input },
    });
  const task = storage.repositories.tasks.upsert(
    TaskSchema.parse({
      id: 'task',
      projectId: 'p',
      title: 'Settings test',
      objective: 'Retain applied model',
      state: 'completed',
      ownerAgentId: 'agent',
      dependencyIds: [],
      contextRefs: [],
      resultArtifactRefs: [],
      createdAt: '2026-10-25T00:00:00Z',
      updatedAt: '2026-10-25T00:00:00Z',
    }),
  );
  return {
    app,
    runtime,
    storage,
    call,
    task,
    async close() {
      await runtime.close();
      await app.close();
      storage.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('shares advertised settings, CAS defaults and confirmed task settings across web and MCP', async () => {
  const inspect = vi
    .spyOn(ProcessAgentRuntimeControl.prototype, 'sessionSettings')
    .mockResolvedValue(settings);
  const f = fixture();
  try {
    const read = () =>
      f.app.inject({ method: 'GET', url: '/api/agents/agent/session-settings?projectId=p' });
    expect((await read()).json()).toMatchObject({
      settings: null,
      defaults: { revision: 0, values: {} },
    });
    expect(inspect).not.toHaveBeenCalled();
    const refreshed = await f.call('collaboration_list_agents', {
      projectId: 'p',
      agentId: 'agent',
      refreshSettings: true,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json().result.agents[0].settings).toEqual(settings);
    expect((await read()).json().settings).toEqual(settings);
    expect(inspect).toHaveBeenCalledTimes(1);
    const saved = await f.app.inject({
      method: 'PUT',
      url: '/api/agents/agent/session-settings/defaults',
      payload: { expectedRevision: 0, values: { model: 'test-model' } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/api/agents/agent/session-settings/defaults',
          payload: { expectedRevision: 0, values: {} },
        })
      ).statusCode,
    ).toBe(409);
    const listed = await f.call('collaboration_list_agents', { projectId: 'p', agentId: 'agent' });
    expect(listed.json().result.agents[0].defaults).toEqual(saved.json());
    expect(inspect).toHaveBeenCalledTimes(1);
    const record = f.runtime.sessionSettings.repository.putTask({
      taskId: 'task',
      agentId: 'agent',
      requested: { model: 'test-model' },
      state: 'applied',
      confirmed: settings,
      attemptId: 'attempt',
    });
    expect(
      (await f.app.inject({ method: 'GET', url: '/api/tasks/task/session-settings' })).json(),
    ).toEqual(record);
    const task = await f.call('collaboration_get_task', { taskId: 'task' });
    expect(task.statusCode, task.body).toBe(200);
    expect(task.json().result.sessionSettings).toEqual(record);
    expect(
      (await f.app.inject({ method: 'GET', url: '/api/tasks/missing/session-settings' }))
        .statusCode,
    ).toBe(404);
  } finally {
    await f.close();
  }
});

it('requires authorized project discovery before refreshing and exposes safe inspection failures', async () => {
  const inspect = vi
    .spyOn(ProcessAgentRuntimeControl.prototype, 'sessionSettings')
    .mockResolvedValue(settings);
  const f = fixture();
  try {
    expect(
      (await f.call('collaboration_list_agents', { agentId: 'agent', refreshSettings: true }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await f.call('collaboration_list_agents', {
          projectId: 'private',
          agentId: 'agent',
          refreshSettings: true,
        })
      ).statusCode,
    ).toBe(403);
    expect(inspect).not.toHaveBeenCalled();
    f.runtime.setProjectPolicy('p', {
      expectedRevision: 0,
      tools: { control_discover_agents: 'deny' },
      gitMerge: 'ask',
      gitPush: 'deny',
      requireEnforcedExecution: false,
    });
    expect(
      (
        await f.call('collaboration_list_agents', {
          projectId: 'p',
          agentId: 'agent',
          refreshSettings: true,
        })
      ).statusCode,
    ).toBe(403);
    expect(inspect).not.toHaveBeenCalled();
    inspect.mockRejectedValue(new Error('Private adapter internals'));
    const failed = await f.app.inject({
      method: 'POST',
      url: '/api/agents/agent/session-settings',
      payload: { projectId: 'p' },
    });
    expect(failed.statusCode).toBe(409);
    expect(failed.body).not.toContain('Private adapter internals');
    expect(f.runtime.sessionSettings.repository.getDefaults('agent').revision).toBe(0);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/agents/agent/session-settings',
          payload: { projectId: 'p', values: { model: 'test-model' }, unknown: true },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await f.close();
  }
});

it('passes selected settings through MCP submission and continuation without adding approval authority', async () => {
  const f = fixture();
  try {
    const submit = vi
      .spyOn(f.runtime, 'submitClientTask')
      .mockReturnValue({ task: f.task, reused: false } as never);
    const request = {
      projectId: 'p',
      agentId: 'agent',
      objective: 'Task',
      idempotencyKey: 'first',
      sessionSettings: { model: 'test-model' },
    };
    expect((await f.call('collaboration_submit_task', request)).statusCode).toBe(200);
    expect(submit.mock.calls[0]?.[1]).toMatchObject({ sessionSettings: request.sessionSettings });
    const follow = vi
      .spyOn(f.runtime, 'submitConversationInput')
      .mockReturnValue({ kind: 'followup', task: f.task, reused: false } as never);
    expect(
      (
        await f.call('collaboration_continue_task', {
          taskId: 'task',
          content: 'Continue',
          idempotencyKey: 'second',
          sessionSettings: { model: 'test-model' },
        })
      ).statusCode,
    ).toBe(200);
    expect(follow.mock.calls[0]?.[1]).toMatchObject({ sessionSettings: { model: 'test-model' } });
    expect(clientToolDefinitions.map((tool) => tool.name)).toHaveLength(9);
    expect(clientToolDefinitions.some((tool) => /approve|merge|push/.test(tool.name))).toBe(false);
  } finally {
    await f.close();
  }
});
