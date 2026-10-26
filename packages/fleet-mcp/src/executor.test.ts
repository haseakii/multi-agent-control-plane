import { AgentDefinitionSchema, AgentIdSchema } from '@control-plane/core';
import type { BridgeScope } from '@control-plane/core';
import { describe, expect, it, vi } from 'vitest';
import { createFleetToolExecutor } from './executor.js';
import { FleetRecipientUnavailableError } from './service-error.js';
import type { FleetBridgeHooks, FleetControlServices } from './types.js';

function agent(scopes: readonly BridgeScope[] = ['boss.orchestration']) {
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

function worker(scopes: readonly BridgeScope[] = ['agent.messaging']) {
  return AgentDefinitionSchema.parse({
    ...agent(scopes),
    id: 'worker-agent',
    name: 'Worker',
    orchestration: { canBeBoss: false },
  });
}

function services(): FleetControlServices {
  return {
    searchKnowledge: vi.fn(async () => ({ hits: [] })),
    proposeMemory: vi.fn(async () => ({ status: 'proposed' })),
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
  it.each([
    {
      scope: 'agent.messaging',
      toolName: 'control_send_message',
      input: { targetAgentId: 'peer-agent', type: 'message', content: 'Review is ready' },
      service: 'sendMessage',
    },
    {
      scope: 'artifact.publish',
      toolName: 'control_publish_artifact',
      input: { kind: 'text', mimeType: 'text/plain', content: 'Review' },
      service: 'publishArtifact',
    },
    {
      scope: 'artifact.read',
      toolName: 'control_get_artifact',
      input: { artifactId: 'artifact-1' },
      service: 'getArtifact',
    },
    {
      scope: 'task.status',
      toolName: 'control_get_task',
      input: { taskId: 'task-1' },
      service: 'getTask',
    },
    {
      scope: 'task.status',
      toolName: 'control_wait_task',
      input: { taskId: 'task-1' },
      service: 'waitTask',
    },
  ] as const)(
    'allows worker $toolName only with its independent $scope scope',
    async (testCase) => {
      const shared = services();
      const bridgeHooks = hooks();
      const execute = createFleetToolExecutor({ services: shared, hooks: bridgeHooks });
      const bridgeWorker = worker([testCase.scope]);
      const request = {
        identity: { ...identity(), agentId: bridgeWorker.id },
        agent: bridgeWorker,
        toolName: testCase.toolName,
        input: testCase.input,
      };

      await expect(execute(request)).resolves.toMatchObject({ ok: true });
      expect(shared[testCase.service]).toHaveBeenCalledWith(
        testCase.input,
        expect.objectContaining({
          identity: request.identity,
          agent: expect.objectContaining({ orchestration: { canBeBoss: false } }),
        }),
      );
      expect(bridgeHooks.authorize).toHaveBeenCalledOnce();
      expect(bridgeHooks.audit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'succeeded' }),
      );

      bridgeWorker.controlBridge.scopes = [];
      await expect(execute(request)).resolves.toMatchObject({
        ok: false,
        error: 'Fleet tool scope denied.',
        statusCode: 403,
      });
      expect(shared[testCase.service]).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['control_discover_agents', {}, 'discoverAgents'],
    ['control_get_agent', { agentId: 'peer-agent' }, 'getAgent'],
    ['control_create_task', { title: 'Task', objective: 'Objective' }, 'createTask'],
    ['control_delegate_task', { taskId: 'task-1', agentId: 'peer-agent' }, 'delegateTask'],
    ['control_request_approval', { action: 'test', resource: {} }, 'requestApproval'],
    ['control_cancel_task', { taskId: 'task-1' }, 'cancelTask'],
  ] as const)(
    'denies worker %s without delegating to policy or services',
    async (toolName, input, service) => {
      const shared = services();
      const bridgeHooks = hooks();
      const execute = createFleetToolExecutor({ services: shared, hooks: bridgeHooks });
      const bridgeWorker = worker([
        'agent.messaging',
        'artifact.publish',
        'artifact.read',
        'task.status',
      ]);

      await expect(
        execute({
          identity: { ...identity(), agentId: bridgeWorker.id },
          agent: bridgeWorker,
          toolName,
          input,
        }),
      ).resolves.toEqual({
        ok: false,
        error: 'Fleet tool scope denied.',
        statusCode: 403,
      });
      expect(shared[service]).not.toHaveBeenCalled();
      expect(bridgeHooks.authorize).not.toHaveBeenCalled();
    },
  );

  it('does not let the Boss scope substitute for worker Boss capability', async () => {
    const shared = services();
    const bridgeHooks = hooks();
    const execute = createFleetToolExecutor({ services: shared, hooks: bridgeHooks });
    const bridgeWorker = worker(['boss.orchestration', 'agent.messaging']);

    for (const toolName of [
      'control_discover_agents',
      'control_create_task',
      'control_delegate_task',
    ]) {
      await expect(
        execute({
          identity: { ...identity(), agentId: bridgeWorker.id },
          agent: bridgeWorker,
          toolName,
          input: {},
        }),
      ).resolves.toEqual({
        ok: false,
        error: 'Fleet bridge agent is not eligible.',
        statusCode: 403,
      });
    }
    expect(shared.discoverAgents).not.toHaveBeenCalled();
    expect(shared.createTask).not.toHaveBeenCalled();
    expect(shared.delegateTask).not.toHaveBeenCalled();
    expect(bridgeHooks.authorize).not.toHaveBeenCalled();
  });

  it('rejects disabled workers and workers without an MCP bridge', async () => {
    const shared = services();
    const bridgeHooks = hooks();
    const execute = createFleetToolExecutor({ services: shared, hooks: bridgeHooks });
    const disabled = worker();
    disabled.enabled = false;
    const noBridge = worker();
    noBridge.controlBridge = { transport: 'none', scopes: [] };

    for (const bridgeWorker of [disabled, noBridge]) {
      await expect(
        execute({
          identity: { ...identity(), agentId: bridgeWorker.id },
          agent: bridgeWorker,
          toolName: 'control_send_message',
          input: { targetAgentId: 'peer-agent', type: 'message', content: 'hello' },
        }),
      ).resolves.toMatchObject({ ok: false, statusCode: 403 });
    }
    expect(shared.sendMessage).not.toHaveBeenCalled();
    expect(bridgeHooks.authorize).not.toHaveBeenCalled();
  });

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

  it('serializes only canonical retryable details from a controlled service error', async () => {
    const shared = services();
    const conflict = new FleetRecipientUnavailableError();
    conflict.message = 'private backend detail';
    vi.mocked(shared.sendMessage).mockRejectedValueOnce(conflict);
    const execute = createFleetToolExecutor({ services: shared, hooks: hooks() });
    const result = await execute({
      identity: identity(),
      agent: agent(['agent.messaging']),
      toolName: 'control_send_message',
      input: { targetAgentId: 'peer', type: 'message' },
    });
    expect(result).toMatchObject({
      ok: false,
      statusCode: 409,
      code: 'RECIPIENT_UNAVAILABLE',
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain('private backend detail');
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
