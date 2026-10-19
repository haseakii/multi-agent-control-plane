import { AgentDefinitionSchema } from '@control-plane/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetMcpBridge, type FleetMcpPrincipal, type FleetMcpServices } from './fleet-mcp.js';

function definition(
  scopes: Array<
    'boss.orchestration' | 'agent.messaging' | 'artifact.read' | 'artifact.publish' | 'task.status'
  >,
  canBeBoss = false,
) {
  return AgentDefinitionSchema.parse({
    id: 'agent-a',
    name: 'Agent A',
    enabled: true,
    runtime: { type: 'acp-stdio', command: 'agent-a', args: [] },
    capabilities: [{ name: 'code.read', source: 'configured' }],
    auth: { mode: 'agent-managed' },
    orchestration: { canBeBoss },
    controlBridge: { transport: 'mcp', scopes },
  });
}

function principal(scopes: FleetMcpPrincipal['scopes']): FleetMcpPrincipal {
  return {
    agentId: 'agent-a',
    projectId: 'project-a',
    sessionId: 'session-a',
    scopes,
  };
}

function createServices() {
  const services: FleetMcpServices = {
    agents: {
      discover: vi.fn(async () => ({ agents: [] })),
      get: vi.fn(async ({ agentId }) => ({ id: agentId })),
    },
    tasks: {
      create: vi.fn(async ({ title }) => ({ id: 'task-created', title })),
      delegate: vi.fn(async ({ taskId, agentId }) => ({ taskId, agentId })),
      get: vi.fn(async ({ taskId }) => ({ id: taskId, state: 'ready' })),
      wait: vi.fn(async ({ taskId }) => ({ id: taskId, state: 'completed' })),
      cancel: vi.fn(async ({ taskId }) => ({ id: taskId, state: 'cancelled' })),
    },
    messages: {
      send: vi.fn(async ({ taskId }) => ({ taskId, sent: true })),
    },
    artifacts: {
      publish: vi.fn(async ({ taskId, kind }) => ({ id: 'artifact-a', taskId, kind })),
      get: vi.fn(async ({ artifactId }) => ({ id: artifactId })),
    },
    approvals: {
      request: vi.fn(async ({ action }) => ({ id: 'approval-a', action })),
    },
    policy: {
      authorize: vi.fn(async () => ({ allowed: true })),
    },
    audit: {
      record: vi.fn(async () => {}),
    },
  };
  return services;
}

describe('FleetMcpBridge', () => {
  let services: FleetMcpServices;

  beforeEach(() => {
    services = createServices();
  });

  it('exposes only tools allowed by the authenticated session scopes', async () => {
    const bridge = new FleetMcpBridge(
      definition(['task.status']),
      principal(['task.status']),
      {
        readiness: { runtime: 'ready', auth: 'not_reported' },
        supportsSessionMcp: true,
        bossAssignmentAllowed: false,
      },
      services,
    );

    expect(bridge.listTools().map((tool) => tool.name)).toEqual(['control_get_task']);
    await expect(bridge.call('control_get_task', { taskId: 'task-a' })).resolves.toEqual({
      id: 'task-a',
      state: 'ready',
    });
    expect(services.tasks.get).toHaveBeenCalledWith({ taskId: 'task-a' }, bridge.principal);
    expect(services.policy.authorize).toHaveBeenCalledTimes(1);
    expect(services.audit.record).toHaveBeenCalledTimes(2);
    expect(services.audit.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ operation: 'control_get_task', phase: 'attempted' }),
    );
    expect(services.audit.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ operation: 'control_get_task', phase: 'completed' }),
    );
  });

  it('fails closed when policy denies a tool call and audits the denial', async () => {
    vi.mocked(services.policy.authorize).mockResolvedValue({
      allowed: false,
      reason: 'task is outside the active project',
    });
    const bridge = new FleetMcpBridge(
      definition(['boss.orchestration'], true),
      principal(['boss.orchestration']),
      {
        readiness: { runtime: 'ready', auth: 'ready' },
        supportsSessionMcp: true,
        bossAssignmentAllowed: true,
      },
      services,
    );

    await expect(
      bridge.call('control_create_task', { title: 'T', objective: 'O' }),
    ).rejects.toThrow('task is outside the active project');
    expect(services.tasks.create).not.toHaveBeenCalled();
    expect(services.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'control_create_task', phase: 'denied' }),
    );
  });

  it('does not include artifact content in policy or audit resource metadata', async () => {
    const bridge = new FleetMcpBridge(
      definition(['artifact.publish']),
      principal(['artifact.publish']),
      {
        readiness: { runtime: 'ready', auth: 'ready' },
        supportsSessionMcp: true,
        bossAssignmentAllowed: false,
      },
      services,
    );

    await bridge.call('control_publish_artifact', {
      kind: 'report',
      mimeType: 'text/plain',
      content: 'private artifact body',
    });

    expect(services.artifacts.publish).toHaveBeenCalledWith(
      { kind: 'report', mimeType: 'text/plain', content: 'private artifact body' },
      bridge.principal,
    );
    const policyResource = vi.mocked(services.policy.authorize).mock.calls[0]?.[0].resource;
    expect(policyResource).toMatchObject({
      kind: 'report',
      mimeType: 'text/plain',
      content: 'private artifact body',
    });
    expect(JSON.stringify(policyResource)).toContain('private artifact body');
    const auditEvents = vi.mocked(services.audit.record).mock.calls.map(([event]) => event);
    expect(JSON.stringify(auditEvents)).not.toContain('private artifact body');
  });

  it('fails closed if policy evaluation errors and audits a non-sensitive denial reason', async () => {
    vi.mocked(services.policy.authorize).mockRejectedValue(new Error('secret policy backend detail'));
    const bridge = new FleetMcpBridge(
      definition(['boss.orchestration'], true),
      principal(['boss.orchestration']),
      {
        readiness: { runtime: 'ready', auth: 'ready' },
        supportsSessionMcp: true,
        bossAssignmentAllowed: true,
      },
      services,
    );

    await expect(
      bridge.call('control_create_task', { title: 'T', objective: 'O' }),
    ).rejects.toThrow('Policy evaluation failed');
    expect(services.tasks.create).not.toHaveBeenCalled();
    expect(services.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'control_create_task',
        phase: 'denied',
        reason: 'policy_evaluation_failed',
      }),
    );
    expect(JSON.stringify(vi.mocked(services.audit.record).mock.calls)).not.toContain(
      'secret policy backend detail',
    );
  });

  it('does not persist raw service error messages into audit records', async () => {
    vi.mocked(services.tasks.get).mockRejectedValue(new Error('provider token leaked in error'));
    const bridge = new FleetMcpBridge(
      definition(['task.status']),
      principal(['task.status']),
      {
        readiness: { runtime: 'ready', auth: 'ready' },
        supportsSessionMcp: true,
        bossAssignmentAllowed: false,
      },
      services,
    );

    await expect(bridge.call('control_get_task', { taskId: 'task-a' })).rejects.toThrow(
      'provider token leaked in error',
    );
    expect(services.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'control_get_task', phase: 'failed', reason: 'service_error' }),
    );
    expect(JSON.stringify(vi.mocked(services.audit.record).mock.calls)).not.toContain(
      'provider token leaked in error',
    );
  });

  it('lets policy inspect approval resources without copying resource values into audit records', async () => {
    const bridge = new FleetMcpBridge(
      definition(['boss.orchestration'], true),
      principal(['boss.orchestration']),
      {
        readiness: { runtime: 'ready', auth: 'ready' },
        supportsSessionMcp: true,
        bossAssignmentAllowed: true,
      },
      services,
    );
    const resource = { targetPath: '/private/project.env', operation: 'write' };

    await bridge.call('control_request_approval', {
      action: 'write-file',
      resource,
    });

    expect(services.policy.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ resource: { action: 'write-file', resource } }),
    );
    const auditEvents = vi.mocked(services.audit.record).mock.calls.map(([event]) => event);
    expect(JSON.stringify(auditEvents)).not.toContain('/private/project.env');
    expect(auditEvents[0]?.resource).toMatchObject({
      action: 'write-file',
      resourceKeys: ['targetPath', 'operation'],
    });
  });

  it('rejects unsafe bridge attachments and scopes outside the configured ceiling', () => {
    expect(
      () =>
        new FleetMcpBridge(
          definition(['boss.orchestration'], true),
          principal(['boss.orchestration']),
          {
            readiness: { runtime: 'unknown', auth: 'unknown' },
            supportsSessionMcp: true,
            bossAssignmentAllowed: true,
          },
          services,
        ),
    ).toThrow('readiness is insufficient');

    expect(
      () =>
        new FleetMcpBridge(
          definition(['task.status']),
          principal(['boss.orchestration']),
          {
            readiness: { runtime: 'ready', auth: 'ready' },
            supportsSessionMcp: true,
            bossAssignmentAllowed: false,
          },
          services,
        ),
    ).toThrow('scope ceiling');
  });
});
