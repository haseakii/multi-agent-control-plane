import { AgentDefinitionSchema, AgentIdSchema } from '@control-plane/core';
import type { FleetBridgeGrantResolver } from '@control-plane/fleet-mcp';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from './server.js';

function agent() {
  return AgentDefinitionSchema.parse({
    id: 'boss-agent',
    name: 'Boss',
    enabled: true,
    runtime: { type: 'acp-stdio', command: 'boss-agent', args: [] },
    capabilities: [{ name: 'planning', source: 'verified' }],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss: true },
    controlBridge: {
      transport: 'mcp',
      scopes: ['boss.orchestration', 'artifact.read'],
    },
  });
}

function grants(bound = true): FleetBridgeGrantResolver {
  return {
    resolve(token) {
      if (token !== 'valid-grant') {
        throw new Error('invalid');
      }
      return {
        agentId: AgentIdSchema.parse('boss-agent'),
        projectId: 'project-1',
        taskId: 'task-1',
        scopes: ['boss.orchestration'],
        ...(bound ? { sessionId: 'session-1' } : {}),
        expiresAt: '2026-10-20T06:00:00.000Z',
      };
    },
  };
}

describe('Fleet bridge gateway', () => {
  it('returns a session-scoped manifest without widening the configured scope ceiling', async () => {
    const app = buildServer({
      fleetGateway: {
        grants: grants(),
        getAgent: () => agent(),
        execute: vi.fn(),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/internal/fleet/manifest',
      headers: { authorization: 'Bearer valid-grant' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      identity: {
        agentId: 'boss-agent',
        projectId: 'project-1',
        sessionId: 'session-1',
        taskId: 'task-1',
      },
      agent: {
        id: 'boss-agent',
        controlBridge: {
          transport: 'mcp',
          scopes: ['boss.orchestration'],
        },
      },
    });
    await app.close();
  });

  it('binds tool execution identity from the grant and never accepts identity from request input', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, result: { state: 'completed' } }));
    const app = buildServer({
      fleetGateway: {
        grants: grants(),
        getAgent: () => agent(),
        execute,
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/fleet/tool',
      headers: {
        authorization: 'Bearer valid-grant',
        'content-type': 'application/json',
      },
      payload: {
        toolName: 'control_get_task',
        input: {
          taskId: 'task-1',
          agentId: 'attacker-controlled',
          sessionId: 'attacker-session',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          agentId: 'boss-agent',
          projectId: 'project-1',
          sessionId: 'session-1',
          taskId: 'task-1',
        },
        scopes: ['boss.orchestration'],
        toolName: 'control_get_task',
        input: {
          taskId: 'task-1',
          agentId: 'attacker-controlled',
          sessionId: 'attacker-session',
        },
      }),
    );
    await app.close();
  });

  it('rejects missing, invalid, and not-yet-bound grants before application dispatch', async () => {
    const execute = vi.fn();
    const auditDenied = vi.fn(async () => undefined);
    const invalidApp = buildServer({
      fleetGateway: {
        grants: grants(),
        getAgent: () => agent(),
        execute,
        auditDenied,
      },
    });

    expect(
      (
        await invalidApp.inject({
          method: 'GET',
          url: '/internal/fleet/manifest',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await invalidApp.inject({
          method: 'GET',
          url: '/internal/fleet/manifest',
          headers: { authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401);
    await invalidApp.close();

    const pendingApp = buildServer({
      fleetGateway: {
        grants: grants(false),
        getAgent: () => agent(),
        execute,
        auditDenied,
      },
    });
    const pending = await pendingApp.inject({
      method: 'POST',
      url: '/internal/fleet/tool',
      headers: { authorization: 'Bearer valid-grant' },
      payload: { toolName: 'control_get_task', input: { taskId: 'task-1' } },
    });
    expect(pending.statusCode).toBe(409);
    expect(execute).not.toHaveBeenCalled();
    expect(auditDenied.mock.calls.map(([record]) => record.reason)).toEqual([
      'authorization_missing',
      'authorization_invalid',
      'session_unbound',
    ]);
    expect(JSON.stringify(auditDenied.mock.calls)).not.toContain('valid-grant');
    expect(JSON.stringify(auditDenied.mock.calls)).not.toContain('wrong');
    await pendingApp.close();
  });

  it('allows messaging-only worker grants without Boss privileges and rejects escalation', async () => {
    const worker = AgentDefinitionSchema.parse({
      ...agent(),
      orchestration: { canBeBoss: false },
      controlBridge: { transport: 'mcp', scopes: ['agent.messaging', 'boss.orchestration'] },
    });
    let elevated = false;
    const resolver: FleetBridgeGrantResolver = {
      resolve: () => ({
        agentId: worker.id,
        projectId: 'project-1',
        taskId: 'task-1',
        sessionId: 'worker-session',
        scopes: elevated ? ['boss.orchestration'] : ['agent.messaging'],
        expiresAt: '2026-10-20T06:00:00.000Z',
      }),
    };
    const auditDenied = vi.fn(async () => undefined);
    const app = buildServer({
      fleetGateway: { grants: resolver, getAgent: () => worker, execute: vi.fn(), auditDenied },
    });
    const manifest = await app.inject({
      method: 'GET',
      url: '/internal/fleet/manifest',
      headers: { authorization: 'Bearer valid-grant' },
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().agent.controlBridge.scopes).toEqual(['agent.messaging']);
    expect(manifest.json().agent.orchestration.canBeBoss).toBe(false);
    elevated = true;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/internal/fleet/manifest',
          headers: { authorization: 'Bearer valid-grant' },
        })
      ).statusCode,
    ).toBe(403);
    expect(auditDenied).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'scope_ineligible' }),
    );
    await app.close();
  });

  it('rejects grants whose scopes exceed the current AgentDefinition ceiling', async () => {
    const resolver: FleetBridgeGrantResolver = {
      resolve: () => ({
        agentId: AgentIdSchema.parse('boss-agent'),
        projectId: 'project-1',
        scopes: ['artifact.publish'],
        sessionId: 'session-1',
        expiresAt: '2026-10-20T06:00:00.000Z',
      }),
    };
    const app = buildServer({
      fleetGateway: {
        grants: resolver,
        getAgent: () => agent(),
        execute: vi.fn(),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/internal/fleet/manifest',
      headers: { authorization: 'Bearer valid-grant' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('does not leak thrown application-service errors to the MCP proxy', async () => {
    const app = buildServer({
      fleetGateway: {
        grants: grants(),
        getAgent: () => agent(),
        execute: async () => {
          throw new Error('provider token leaked in internal error');
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/internal/fleet/tool',
      headers: { authorization: 'Bearer valid-grant' },
      payload: { toolName: 'control_get_task', input: { taskId: 'task-1' } },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('provider token');
    expect(response.json()).toEqual({
      ok: false,
      error: 'Fleet bridge tool execution failed.',
    });
    await app.close();
  });
});
