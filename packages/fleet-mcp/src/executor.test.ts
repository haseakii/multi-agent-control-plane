import { AgentDefinitionSchema, AgentIdSchema } from '@control-plane/core';
import { describe, expect, it, vi } from 'vitest';
import { createFleetToolExecutor } from './executor.js';
import type { FleetBridgeHooks, FleetControlServices } from './types.js';

function agent(scopes = ['boss.orchestration'] as const) {
  return AgentDefinitionSchema.parse({
    id: 'boss-agent',
    name: 'Boss',
    enabled: true,
    runtime: { type: 'acp-stdio', command: 'boss-agent', args: [] },
    capabilities: [{ name: 'planning', source: 'verified' }],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: true },
    controlBridge: { transport: 'mcp', scopes: [...scopes] },
  });
}

function services(): FleetControlServices {
  return {
    discoverAgents: vi.fn(async (input) => ({ input })),
    getAgent: vi.fn(async ({ agentId }) => ({ id: agentId })),
    createTask: vi.fn(async (input) => ({ id: 'task-new', ...input })),
    delegateTask: vi.fn(async (input) => ({ delegated: true, ...input })),
    getTask: vi.fn(async ({ taskId }) => ({ id: taskId, state: 'ready' })),
    waitTask: vi.fn(async ({ taskId }) => ({ id: taskId, state: 'completed' })),
    sendMessage: vi.fn(async (input) => ({ id: 'message-1', ...input })),
    publishArtifact: vi.fn(async (input) => ({ id: 'artifact-1', ...input })),
    getArtifact: vi.fn(async ({ artifactId }) => ({ id: artifactId })),
    requestApproval: vi.fn(async (input) => ({ id: 'approval-1', ...input })),
    cancelTask: vi.fn(async ({ taskId }) => ({ id: taskId, state: 'cancelled' })),
  };
}

function hooks(): FleetBridgeHooks & {
  authorize: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
} {
  return {
    authorize: vi.fn(async () => ({ allowed: true as const })),
    audit: vi.fn(async () => undefined),
  };
}

function identity() {
  return {
    agentId: AgentIdSchema.parse('boss-agent'),
    projectId: 'project-1',
    sessionId: 'session-1',
    taskId: 'root-task',
  };
}

describe('createFleetToolExecutor', () => {
  it('revalidates tool input and dispatches through the shared service with grant-bound context', async () => {
    const shared = services();
    const bridgeHooks = hooks();
    const execute = createFleetToolExecutor({ services: shared, hooks: bridgeHooks });

    const result = await execute({
      identity: identity(),
      agent: agent(),
      toolName: 'control_create_task',
      input: { title: 'Review', objective: 'Review boundaries' },
    });

    expect(result).toMatchObject({ ok: true });
    expect(shared.createTask).toHaveBeenCalledWith(
      { title: 'Review', objective: 'Review boundaries' },
      expect.objectContaining({
        identity: identity(),
        toolName: 'control_create_task',
        operation: 'tasks.create',
      }),
    );
    expect(bridgeHooks.authorize).toHaveBeenCalledOnce();
    expect(bridgeHooks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded' }),
    );
  });

  it('fails closed when bridge identity does not match the configured agent', async () => {
    const shared = services();
    const execute = createFleetToolExecutor({ services: shared, hooks: hooks() });

    const result = await execute({
      identity: { ...identity(), agentId: AgentIdSchema.parse('other-agent') },
      agent: agent(),
      toolName: 'control_get_task',
      input: { taskId: 'task-1' },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Fleet bridge identity mismatch.',
      statusCode: 403,
    });
    expect(shared.getTask).not.toHaveBeenCalled();
  });

  it('fails closed for unknown tools, invalid payloads, and missing scopes before service dispatch', async () => {
    const shared = services();
    const execute = createFleetToolExecutor({ services: shared, hooks: hooks() });

    await expect(
      execute({
        identity: identity(),
        agent: agent(),
        toolName: 'control_not_real',
        input: {},
      }),
    ).resolves.toEqual({ ok: false, error: 'Unknown Fleet tool.', statusCode: 404 });

    await expect(
      execute({
        identity: identity(),
        agent: agent(),
        toolName: 'control_create_task',
        input: { title: 'missing-objective' },
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Fleet tool input is invalid.',
      statusCode: 400,
    });

    await expect(
      execute({
        identity: identity(),
        agent: agent(),
        toolName: 'control_send_message',
        input: { targetAgentId: 'worker', type: 'message', content: 'hello' },
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'Fleet tool scope denied.',
      statusCode: 403,
    });

    expect(shared.createTask).not.toHaveBeenCalled();
    expect(shared.sendMessage).not.toHaveBeenCalled();
  });

  it('passes sensitive content to policy/services but redacts it from audits and service failures', async () => {
    const shared = services();
    const bridgeHooks = hooks();
    vi.mocked(shared.publishArtifact).mockRejectedValueOnce(
      new Error('provider token in backend failure'),
    );
    const execute = createFleetToolExecutor({ services: shared, hooks: bridgeHooks });

    const result = await execute({
      identity: identity(),
      agent: agent(['artifact.publish'] as const),
      toolName: 'control_publish_artifact',
      input: {
        kind: 'text',
        mimeType: 'text/plain',
        content: 'private artifact body',
      },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Fleet tool service failed.',
      statusCode: 500,
    });
    expect(JSON.stringify(vi.mocked(bridgeHooks.authorize).mock.calls)).toContain(
      'private artifact body',
    );
    const audit = JSON.stringify(vi.mocked(bridgeHooks.audit).mock.calls);
    expect(audit).not.toContain('private artifact body');
    expect(audit).not.toContain('provider token in backend failure');
    expect(audit).toContain('contentBytes');
    expect(audit).toContain('service_error');
  });

  it('does not expose policy denial details to the MCP proxy', async () => {
    const shared = services();
    const bridgeHooks = hooks();
    vi.mocked(bridgeHooks.authorize).mockResolvedValueOnce({
      allowed: false,
      reason: 'sensitive policy backend explanation',
    });
    const execute = createFleetToolExecutor({ services: shared, hooks: bridgeHooks });

    const result = await execute({
      identity: identity(),
      agent: agent(),
      toolName: 'control_cancel_task',
      input: { taskId: 'task-1' },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Fleet tool policy denied.',
      statusCode: 403,
    });
    expect(JSON.stringify(result)).not.toContain('sensitive policy backend explanation');
    expect(shared.cancelTask).not.toHaveBeenCalled();
  });

  it('fails closed when policy throws and does not call shared services', async () => {
    const shared = services();
    const bridgeHooks = hooks();
    vi.mocked(bridgeHooks.authorize).mockRejectedValueOnce(
      new Error('secret policy backend detail'),
    );
    const execute = createFleetToolExecutor({ services: shared, hooks: bridgeHooks });

    const result = await execute({
      identity: identity(),
      agent: agent(),
      toolName: 'control_cancel_task',
      input: { taskId: 'task-1' },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Policy evaluation failed.',
      statusCode: 403,
    });
    expect(shared.cancelTask).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(bridgeHooks.audit).mock.calls)).not.toContain(
      'secret policy backend detail',
    );
  });
});
