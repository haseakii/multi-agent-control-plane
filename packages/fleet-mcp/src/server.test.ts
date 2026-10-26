import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentDefinitionSchema, AgentIdSchema } from '@control-plane/core';
import type { AgentDefinition, BridgeScope } from '@control-plane/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFleetMcpServer } from './server.js';
import type { FleetBridgeHooks, FleetControlServices } from './types.js';

function boss(
  scopes: readonly (
    | 'boss.orchestration'
    | 'agent.messaging'
    | 'artifact.read'
    | 'artifact.publish'
    | 'task.status'
    | 'knowledge.read'
    | 'memory.propose'
  )[] = ['boss.orchestration', 'agent.messaging', 'artifact.read', 'artifact.publish'],
) {
  return AgentDefinitionSchema.parse({
    id: 'agent-boss',
    name: 'Boss candidate',
    enabled: true,
    runtime: { type: 'acp-stdio', command: 'boss-agent', args: [] },
    capabilities: [{ name: 'code.read', source: 'verified' }],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: true },
    controlBridge: { transport: 'mcp', scopes: [...scopes] },
  });
}

function worker(scopes: readonly BridgeScope[] = ['agent.messaging']) {
  return AgentDefinitionSchema.parse({
    ...boss(scopes),
    id: 'agent-worker',
    name: 'Worker',
    orchestration: { canBeBoss: false },
  });
}

function services(): FleetControlServices {
  return {
    searchKnowledge: vi.fn(async () => ({ hits: [] })),
    proposeMemory: vi.fn(async () => ({ status: 'proposed' })),
    discoverAgents: vi.fn(async (input) => ({ input, agents: ['agent-worker'] })),
    getAgent: vi.fn(async ({ agentId }) => ({ id: agentId })),
    createTask: vi.fn(async (input) => ({ id: 'task-created', ...input })),
    delegateTask: vi.fn(async (input) => ({ delegated: true, ...input })),
    getTask: vi.fn(async ({ taskId }) => ({ id: taskId, state: 'running' })),
    waitTask: vi.fn(async ({ taskId }) => ({ id: taskId, state: 'completed' })),
    sendMessage: vi.fn(async (input) => ({ messageId: 'message-1', ...input })),
    publishArtifact: vi.fn(async (input) => ({ artifactId: 'artifact-1', ...input })),
    getArtifact: vi.fn(async ({ artifactId }) => ({ id: artifactId })),
    requestApproval: vi.fn(async (input) => ({ approvalId: 'approval-1', ...input })),
    cancelTask: vi.fn(async ({ taskId }) => ({ id: taskId, state: 'cancelled' })),
  };
}

function hooks(allow = true): FleetBridgeHooks & {
  authorize: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
} {
  return {
    authorize: vi.fn(async () =>
      allow ? { allowed: true as const } : { allowed: false as const, reason: 'policy denied' },
    ),
    audit: vi.fn(async () => undefined),
  };
}

const clients: Client[] = [];
const servers: ReturnType<typeof createFleetMcpServer>[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function connected(options?: {
  agent?: AgentDefinition;
  scopes?: readonly (
    | 'boss.orchestration'
    | 'agent.messaging'
    | 'artifact.read'
    | 'artifact.publish'
    | 'task.status'
    | 'knowledge.read'
    | 'memory.propose'
  )[];
  allow?: boolean;
}) {
  const bridgeAgent =
    options?.agent ??
    boss(
      options?.scopes ?? [
        'boss.orchestration',
        'agent.messaging',
        'artifact.read',
        'artifact.publish',
      ],
    );
  const bridgeServices = services();
  const bridgeHooks = hooks(options?.allow ?? true);
  const server = createFleetMcpServer({
    identity: {
      agentId: bridgeAgent.id,
      projectId: 'project-1',
      sessionId: 'session-1',
      taskId: 'task-root',
    },
    agent: bridgeAgent,
    services: bridgeServices,
    hooks: bridgeHooks,
  });
  const client = new Client({ name: 'fleet-mcp-test', version: '0.1.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  servers.push(server);
  clients.push(client);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, bridgeServices, bridgeHooks };
}

describe('Fleet MCP bridge', () => {
  it('exposes only messaging to a messaging-only worker, without assigning Boss capability', async () => {
    const { client, bridgeServices, bridgeHooks } = await connected({ agent: worker() });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(['control_send_message']);

    const result = await client.callTool({
      name: 'control_send_message',
      arguments: { targetAgentId: 'agent-peer', type: 'message', content: 'Review ready' },
    });

    expect(result.isError).not.toBe(true);
    expect(bridgeServices.sendMessage).toHaveBeenCalledWith(
      { targetAgentId: 'agent-peer', type: 'message', content: 'Review ready' },
      expect.objectContaining({
        identity: expect.objectContaining({ agentId: 'agent-worker' }),
        agent: expect.objectContaining({ orchestration: { canBeBoss: false } }),
      }),
    );
    expect(bridgeHooks.authorize).toHaveBeenCalledOnce();
  });

  it('exposes independently scoped worker artifact/status tools but no Boss operations', async () => {
    const { client, bridgeServices } = await connected({
      agent: worker(['artifact.publish', 'artifact.read', 'task.status']),
    });
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'control_get_artifact',
      'control_get_task',
      'control_publish_artifact',
      'control_wait_task',
    ]);

    for (const request of [
      { name: 'control_get_artifact', arguments: { artifactId: 'artifact-1' } },
      { name: 'control_get_task', arguments: { taskId: 'task-1' } },
      {
        name: 'control_publish_artifact',
        arguments: { kind: 'text', mimeType: 'text/plain', content: 'Review' },
      },
      { name: 'control_wait_task', arguments: { taskId: 'task-1' } },
    ]) {
      expect((await client.callTool(request)).isError).not.toBe(true);
    }
    expect(bridgeServices.getArtifact).toHaveBeenCalledOnce();
    expect(bridgeServices.getTask).toHaveBeenCalledOnce();
    expect(bridgeServices.publishArtifact).toHaveBeenCalledOnce();
    expect(bridgeServices.waitTask).toHaveBeenCalledOnce();
  });

  it.each([
    ['control_discover_agents', {}],
    ['control_get_agent', { agentId: 'agent-peer' }],
    ['control_create_task', { title: 'Task', objective: 'Objective' }],
    ['control_delegate_task', { taskId: 'task-1', agentId: 'agent-peer' }],
    ['control_request_approval', { action: 'test', resource: {} }],
    ['control_cancel_task', { taskId: 'task-1' }],
  ] as const)('does not dispatch worker attempts to call unregistered %s', async (name, input) => {
    const { client, bridgeServices, bridgeHooks } = await connected({
      agent: worker(['agent.messaging', 'artifact.read', 'artifact.publish', 'task.status']),
    });

    const result = await client.callTool({ name, arguments: input });

    expect(result.isError).toBe(true);
    expect(bridgeHooks.authorize).not.toHaveBeenCalled();
    expect(
      Object.values(bridgeServices).every((service) => vi.mocked(service).mock.calls.length === 0),
    ).toBe(true);
  });

  it('exposes scoped tools and forwards discovery through shared services with bound identity', async () => {
    const { client, bridgeServices, bridgeHooks } = await connected();
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [
        'control_cancel_task',
        'control_create_task',
        'control_delegate_task',
        'control_discover_agents',
        'control_get_agent',
        'control_get_artifact',
        'control_get_task',
        'control_publish_artifact',
        'control_request_approval',
        'control_send_message',
        'control_wait_task',
      ].sort(),
    );

    const result = await client.callTool({
      name: 'control_discover_agents',
      arguments: { exact: ['code.read'], prefixes: ['unity.'], limit: 3 },
    });

    expect(result.isError).not.toBe(true);
    expect(bridgeServices.discoverAgents).toHaveBeenCalledOnce();
    const [, context] = vi.mocked(bridgeServices.discoverAgents).mock.calls[0]!;
    expect(context.identity.agentId).toBe('agent-boss');
    expect(context.identity.projectId).toBe('project-1');
    expect(context.operation).toBe('agents.discover');
    expect(bridgeHooks.authorize).toHaveBeenCalledOnce();
    expect(bridgeHooks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'control_discover_agents',
        outcome: 'succeeded',
      }),
    );
  });

  it('does not expose messaging/artifact tools when their independent scopes are absent', async () => {
    const { client } = await connected({ scopes: ['boss.orchestration'] });
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).not.toContain('control_send_message');
    expect(names).not.toContain('control_publish_artifact');
    expect(names).not.toContain('control_get_artifact');
    expect(names).toContain('control_create_task');
    expect(names).toContain('control_get_task');
  });

  it('policy-checks every invocation and audits denials without calling application services', async () => {
    const { client, bridgeServices, bridgeHooks } = await connected({ allow: false });

    const result = await client.callTool({
      name: 'control_cancel_task',
      arguments: { taskId: 'task-1' },
    });

    expect(result.isError).toBe(true);
    expect(bridgeServices.cancelTask).not.toHaveBeenCalled();
    expect(bridgeHooks.authorize).toHaveBeenCalledOnce();
    expect(bridgeHooks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'control_cancel_task',
        operation: 'tasks.cancel',
        outcome: 'denied',
        reason: 'policy_denied',
      }),
    );
  });

  it('redacts message, artifact, approval, and service-error details from audit records', async () => {
    const { client, bridgeServices, bridgeHooks } = await connected();

    await client.callTool({
      name: 'control_send_message',
      arguments: {
        targetAgentId: 'agent-worker',
        type: 'message',
        content: 'provider-token-secret',
      },
    });
    await client.callTool({
      name: 'control_publish_artifact',
      arguments: {
        kind: 'text',
        mimeType: 'text/plain',
        content: 'private artifact body',
      },
    });
    await client.callTool({
      name: 'control_request_approval',
      arguments: {
        action: 'write-file',
        resource: { targetPath: '/private/project.env', token: 'do-not-log' },
      },
    });

    vi.mocked(bridgeServices.getTask).mockRejectedValueOnce(
      new Error('provider token leaked in service error'),
    );
    const failed = await client.callTool({
      name: 'control_get_task',
      arguments: { taskId: 'task-1' },
    });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('provider token leaked in service error');

    const serializedAudit = JSON.stringify(vi.mocked(bridgeHooks.audit).mock.calls);
    expect(serializedAudit).not.toContain('provider-token-secret');
    expect(serializedAudit).not.toContain('private artifact body');
    expect(serializedAudit).not.toContain('/private/project.env');
    expect(serializedAudit).not.toContain('do-not-log');
    expect(serializedAudit).not.toContain('provider token leaked in service error');
    expect(serializedAudit).toContain('contentBytes');
    expect(serializedAudit).toContain('resourceOmitted');
    expect(serializedAudit).toContain('service_error');
  });

  it('fails closed and audits a generic reason when policy evaluation throws', async () => {
    const { client, bridgeServices, bridgeHooks } = await connected();
    vi.mocked(bridgeHooks.authorize).mockRejectedValueOnce(
      new Error('secret policy backend detail'),
    );

    const result = await client.callTool({
      name: 'control_create_task',
      arguments: { title: 'Task', objective: 'Objective' },
    });

    expect(result.isError).toBe(true);
    expect(bridgeServices.createTask).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(bridgeHooks.audit).mock.calls)).not.toContain(
      'secret policy backend detail',
    );
    expect(bridgeHooks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'control_create_task',
        outcome: 'denied',
        reason: 'policy_evaluation_failed',
      }),
    );
  });

  it('rejects agents that are not eligible for the Boss MCP bridge', () => {
    const ineligible = AgentDefinitionSchema.parse({
      ...boss(),
      orchestration: { canBeBoss: false },
    });

    expect(() =>
      createFleetMcpServer({
        identity: {
          agentId: AgentIdSchema.parse('agent-boss'),
          projectId: 'project-1',
          sessionId: 'session-1',
        },
        agent: ineligible,
        services: services(),
        hooks: hooks(),
      }),
    ).toThrow('not Boss-capable');
  });

  it('rejects disabled workers and workers with no MCP bridge', () => {
    const disabled = worker();
    disabled.enabled = false;
    const noBridge = worker([]);
    noBridge.controlBridge.transport = 'none';

    for (const [agent, reason] of [
      [disabled, 'Disabled agents'],
      [noBridge, 'MCP control bridge transport'],
    ] as const) {
      expect(() =>
        createFleetMcpServer({
          identity: {
            agentId: agent.id,
            projectId: 'project-1',
            sessionId: 'session-1',
          },
          agent,
          services: services(),
          hooks: hooks(),
        }),
      ).toThrow(reason);
    }
  });
});
