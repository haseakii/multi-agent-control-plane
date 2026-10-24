import { AgentDefinitionSchema, AgentIdSchema } from '@control-plane/core';
import type {
  FleetBridgeGrantResolver,
  FleetBridgeHooks,
  FleetControlServices,
} from '@control-plane/fleet-mcp';
import { describe, expect, it, vi } from 'vitest';
import { createFleetGatewayOptions } from './fleet-composition.js';
import { buildServer } from './server.js';

const boss = AgentDefinitionSchema.parse({
  id: 'boss-agent',
  name: 'Boss',
  enabled: true,
  runtime: { type: 'acp-stdio', command: 'boss-agent', args: [] },
  capabilities: [{ name: 'planning', source: 'verified' }],
  auth: { mode: 'agent-managed' },
  orchestration: { canBeBoss: true },
  controlBridge: { transport: 'mcp', scopes: ['boss.orchestration'] },
});

function grants(): FleetBridgeGrantResolver {
  return {
    resolve: () => ({
      agentId: AgentIdSchema.parse('boss-agent'),
      projectId: 'project-1',
      taskId: 'root-task',
      sessionId: 'session-1',
      scopes: ['boss.orchestration'],
      expiresAt: '2026-10-20T06:00:00.000Z',
    }),
  };
}

function services(): FleetControlServices {
  return {
    searchKnowledge: vi.fn(async () => ({ hits: [] })),
    proposeMemory: vi.fn(async () => ({ status: 'proposed' })),
    discoverAgents: vi.fn(async () => []),
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

describe('Fleet gateway composition', () => {
  it('routes a grant-authenticated gateway call through shared validation, policy, audit, and services', async () => {
    const shared = services();
    const bridgeHooks = hooks();
    const app = buildServer({
      fleetGateway: createFleetGatewayOptions({
        grants: grants(),
        getAgent: () => boss,
        services: shared,
        hooks: bridgeHooks,
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/fleet/tool',
      headers: { authorization: 'Bearer any-valid-resolver-token' },
      payload: {
        toolName: 'control_create_task',
        input: { title: 'Review', objective: 'Review V0 boundary' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      result: { id: 'task-new', title: 'Review' },
    });
    expect(shared.createTask).toHaveBeenCalledWith(
      { title: 'Review', objective: 'Review V0 boundary' },
      expect.objectContaining({
        identity: {
          agentId: 'boss-agent',
          projectId: 'project-1',
          sessionId: 'session-1',
          taskId: 'root-task',
        },
      }),
    );
    expect(bridgeHooks.authorize).toHaveBeenCalledOnce();
    expect(bridgeHooks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded' }),
    );
    await app.close();
  });

  it('revalidates child input at the parent boundary and rejects scope bypass attempts', async () => {
    const shared = services();
    const app = buildServer({
      fleetGateway: createFleetGatewayOptions({
        grants: grants(),
        getAgent: () => boss,
        services: shared,
        hooks: hooks(),
      }),
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/internal/fleet/tool',
      headers: { authorization: 'Bearer grant' },
      payload: {
        toolName: 'control_create_task',
        input: { title: 'Missing objective' },
      },
    });
    expect(invalid.statusCode).toBe(400);

    const bypass = await app.inject({
      method: 'POST',
      url: '/internal/fleet/tool',
      headers: { authorization: 'Bearer grant' },
      payload: {
        toolName: 'control_send_message',
        input: { targetAgentId: 'worker', type: 'message', content: 'hello' },
      },
    });
    expect(bypass.statusCode).toBe(403);
    expect(shared.createTask).not.toHaveBeenCalled();
    expect(shared.sendMessage).not.toHaveBeenCalled();
    await app.close();
  });
});
