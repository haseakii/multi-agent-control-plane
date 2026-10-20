import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentDefinitionSchema, AgentIdSchema } from '@control-plane/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFleetMcpServer } from './server.js';
import type { FleetBridgeHooks, FleetControlServices } from './types.js';

function boss(
  scopes = ['boss.orchestration', 'agent.messaging', 'artifact.read', 'artifact.publish'] as const,
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

function services(): FleetControlServices {
  return {
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
  scopes?: readonly (
    | 'boss.orchestration'
    | 'agent.messaging'
    | 'artifact.read'
    | 'artifact.publish'
    | 'task.status'
  )[];
  allow?: boolean;
}) {
  const bridgeAgent = boss(
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
      agentId: AgentIdSchema.parse('agent-boss'),
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
        reason: 'policy denied',
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
});
