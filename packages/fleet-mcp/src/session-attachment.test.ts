import { resolve } from 'node:path';
import { AgentDefinitionSchema } from '@control-plane/core';
import { describe, expect, it, vi } from 'vitest';
import {
  FleetBossSessionAttachment,
  FleetSessionAttachment,
  getFleetMcpStdioProxyPath,
} from './session-attachment.js';
import type {
  FleetBossSessionContext,
  FleetBridgeGrantIssuer,
  FleetSessionRuntime,
  FleetSessionContext,
} from './session-attachment.js';

function boss() {
  return AgentDefinitionSchema.parse({
    id: 'boss-agent',
    name: 'Boss',
    enabled: true,
    runtime: { type: 'acp-stdio', command: 'boss-agent', args: [] },
    capabilities: [{ name: 'planning', source: 'verified' }],
    auth: { mode: 'secret-ref', secretRef: 'provider/openai-key' },
    orchestration: { canBeBoss: true },
    controlBridge: {
      transport: 'mcp',
      scopes: ['boss.orchestration', 'agent.messaging', 'artifact.read'],
    },
  });
}

function context(): FleetBossSessionContext {
  return {
    agent: boss(),
    projectId: 'project-1',
    taskId: 'task-root',
    scopes: ['boss.orchestration', 'artifact.read'],
    cwd: resolve('/workspace/project'),
  };
}

function workerContext(): FleetSessionContext {
  return {
    ...context(),
    agent: AgentDefinitionSchema.parse({
      ...boss(),
      id: 'worker-agent',
      orchestration: { canBeBoss: false },
      controlBridge: {
        transport: 'mcp',
        scopes: ['agent.messaging', 'artifact.read', 'artifact.publish', 'task.status'],
      },
    }),
    scopes: ['agent.messaging'],
  };
}

function issuer(): FleetBridgeGrantIssuer & {
  issue: ReturnType<typeof vi.fn>;
  bindSession: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
} {
  let sequence = 0;
  return {
    issue: vi.fn(async () => ({
      token: `bridge-token-${++sequence}`,
      expiresAt: '2026-10-20T06:00:00.000Z',
    })),
    bindSession: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
  };
}

function runtime(): FleetSessionRuntime & {
  newSession: ReturnType<typeof vi.fn>;
  resumeSession: ReturnType<typeof vi.fn>;
} {
  return {
    newSession: vi.fn(async () => ({ sessionId: 'session-new' })),
    resumeSession: vi.fn(async (sessionId: string) => ({ sessionId })),
  };
}

describe('FleetBossSessionAttachment', () => {
  it('attaches a scoped stdio Fleet MCP config on session creation and binds the grant to the returned session', async () => {
    const sessionRuntime = runtime();
    const grants = issuer();
    const attachment = new FleetBossSessionAttachment(sessionRuntime, grants, {
      command: process.execPath,
      args: ['/opt/control-plane/fleet-mcp.mjs', '--stdio'],
      environment: { CONTROL_PLANE_URL: 'http://127.0.0.1:3000' },
    });

    const attached = await attachment.create(context());

    expect(attached.session.sessionId).toBe('session-new');
    expect(grants.issue).toHaveBeenCalledWith({
      agentId: 'boss-agent',
      projectId: 'project-1',
      taskId: 'task-root',
      scopes: ['boss.orchestration', 'artifact.read'],
    });
    expect(grants.bindSession).toHaveBeenCalledWith('bridge-token-1', 'session-new');

    const request = vi.mocked(sessionRuntime.newSession).mock.calls[0]?.[0];
    expect(request?.mcpServers).toEqual([
      {
        name: 'control-plane-fleet',
        command: process.execPath,
        args: ['/opt/control-plane/fleet-mcp.mjs', '--stdio'],
        env: expect.arrayContaining([
          { name: 'CONTROL_PLANE_URL', value: 'http://127.0.0.1:3000' },
          { name: 'CONTROL_PLANE_BRIDGE_GRANT', value: 'bridge-token-1' },
        ]),
      },
    ]);
    expect(JSON.stringify(request?.mcpServers)).not.toContain('provider/openai-key');
  });

  it('issues a fresh grant and recreates Fleet MCP configuration on resume', async () => {
    const sessionRuntime = runtime();
    const grants = issuer();
    const attachment = new FleetBossSessionAttachment(sessionRuntime, grants, {
      command: process.execPath,
      args: ['/opt/control-plane/fleet-mcp.mjs'],
    });

    await attachment.create(context());
    const resumed = await attachment.resume('session-existing', context());

    expect(resumed.session.sessionId).toBe('session-existing');
    expect(grants.issue).toHaveBeenLastCalledWith({
      agentId: 'boss-agent',
      projectId: 'project-1',
      taskId: 'task-root',
      scopes: ['boss.orchestration', 'artifact.read'],
      sessionId: 'session-existing',
    });
    const request = vi.mocked(sessionRuntime.resumeSession).mock.calls[0]?.[1];
    expect(request?.mcpServers?.[0]).toMatchObject({
      name: 'control-plane-fleet',
      command: process.execPath,
    });
    expect(JSON.stringify(request?.mcpServers)).toContain('bridge-token-2');
  });

  it('rejects scope escalation and non-Boss bridge attachment', async () => {
    const sessionRuntime = runtime();
    const attachment = new FleetBossSessionAttachment(sessionRuntime, issuer(), {
      command: process.execPath,
    });

    await expect(
      attachment.create({
        ...context(),
        scopes: ['boss.orchestration', 'artifact.publish'],
      }),
    ).rejects.toThrow('outside the configured ceiling');

    const ineligible = context();
    ineligible.agent = AgentDefinitionSchema.parse({
      ...ineligible.agent,
      orchestration: { canBeBoss: false },
    });
    await expect(attachment.create(ineligible)).rejects.toThrow('not Boss-capable');
    expect(sessionRuntime.newSession).not.toHaveBeenCalled();
  });

  it('revokes an issued grant when ACP session creation fails', async () => {
    const sessionRuntime = runtime();
    vi.mocked(sessionRuntime.newSession).mockRejectedValueOnce(new Error('session/new failed'));
    const grants = issuer();
    const attachment = new FleetBossSessionAttachment(sessionRuntime, grants, {
      command: process.execPath,
    });

    await expect(attachment.create(context())).rejects.toThrow('session/new failed');
    expect(grants.revoke).toHaveBeenCalledWith('bridge-token-1');
    expect(grants.bindSession).not.toHaveBeenCalled();
  });

  it('requires an absolute stdio executable path', () => {
    expect(
      () =>
        new FleetBossSessionAttachment(runtime(), issuer(), {
          command: 'node',
        }),
    ).toThrow('absolute path');
  });

  it('still requires Boss capability and scope when using the Boss-specific attachment', async () => {
    const grants = issuer();
    const attachment = new FleetBossSessionAttachment(runtime(), grants, {
      command: process.execPath,
    });

    await expect(attachment.create(workerContext())).rejects.toThrow('not Boss-capable');
    await expect(attachment.create({ ...context(), scopes: ['artifact.read'] })).rejects.toThrow(
      'Boss session scopes must include boss.orchestration',
    );
    expect(grants.issue).not.toHaveBeenCalled();
  });
});

describe('FleetSessionAttachment', () => {
  it('attaches a messaging-only worker and rotates its scoped grant on resume without granting Boss capability', async () => {
    const sessionRuntime = runtime();
    const grants = issuer();
    const attachment = new FleetSessionAttachment(sessionRuntime, grants, {
      command: process.execPath,
      args: [getFleetMcpStdioProxyPath()],
    });
    const worker = workerContext();

    await attachment.create(worker);
    await attachment.resume('session-existing', worker);

    expect(grants.issue).toHaveBeenNthCalledWith(1, {
      agentId: 'worker-agent',
      projectId: 'project-1',
      taskId: 'task-root',
      scopes: ['agent.messaging'],
    });
    expect(grants.issue).toHaveBeenNthCalledWith(2, {
      agentId: 'worker-agent',
      projectId: 'project-1',
      taskId: 'task-root',
      scopes: ['agent.messaging'],
      sessionId: 'session-existing',
    });
    expect(grants.bindSession).toHaveBeenCalledWith('bridge-token-1', 'session-new');
    expect(sessionRuntime.newSession).toHaveBeenCalledOnce();
    expect(sessionRuntime.resumeSession).toHaveBeenCalledOnce();
    expect(worker.agent.orchestration.canBeBoss).toBe(false);
    expect(worker.scopes).toEqual(['agent.messaging']);
  });

  it('permits independently scoped artifact and status access for a worker', async () => {
    const grants = issuer();
    const attachment = new FleetSessionAttachment(runtime(), grants, {
      command: process.execPath,
    });

    await attachment.create({
      ...workerContext(),
      scopes: ['artifact.publish', 'artifact.read', 'task.status'],
    });

    expect(grants.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ['artifact.publish', 'artifact.read', 'task.status'],
      }),
    );
  });

  it('rejects worker escalation even if its configured ceiling includes the Boss scope', async () => {
    const grants = issuer();
    const attachment = new FleetSessionAttachment(runtime(), grants, {
      command: process.execPath,
    });
    const worker = workerContext();
    worker.agent.controlBridge.scopes.push('boss.orchestration');

    await expect(attachment.create({ ...worker, scopes: ['boss.orchestration'] })).rejects.toThrow(
      'not Boss-capable',
    );
    expect(grants.issue).not.toHaveBeenCalled();

    await attachment.create(worker);
    expect(grants.issue).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['agent.messaging'] }),
    );
  });

  it('rejects disabled, no-bridge, and over-scoped worker sessions before issuing grants', async () => {
    const sessionRuntime = runtime();
    const grants = issuer();
    const attachment = new FleetSessionAttachment(sessionRuntime, grants, {
      command: process.execPath,
    });
    const disabled = workerContext();
    disabled.agent.enabled = false;
    const noBridge = workerContext();
    noBridge.agent.controlBridge = { transport: 'none', scopes: [] };
    noBridge.scopes = [];
    const overScoped = workerContext();
    overScoped.agent.controlBridge.scopes = ['task.status'];

    await expect(attachment.create(disabled)).rejects.toThrow('Disabled agents');
    await expect(attachment.resume('session-existing', noBridge)).rejects.toThrow(
      'MCP control bridge transport',
    );
    await expect(attachment.create(overScoped)).rejects.toThrow('outside the configured ceiling');
    expect(grants.issue).not.toHaveBeenCalled();
    expect(sessionRuntime.newSession).not.toHaveBeenCalled();
    expect(sessionRuntime.resumeSession).not.toHaveBeenCalled();
  });

  it('revokes a worker grant when session binding or resume fails', async () => {
    const sessionRuntime = runtime();
    const grants = issuer();
    grants.bindSession.mockRejectedValueOnce(new Error('session binding failed'));
    sessionRuntime.resumeSession.mockRejectedValueOnce(new Error('session resume failed'));
    const attachment = new FleetSessionAttachment(sessionRuntime, grants, {
      command: process.execPath,
    });

    await expect(attachment.create(workerContext())).rejects.toThrow('session binding failed');
    await expect(attachment.resume('session-existing', workerContext())).rejects.toThrow(
      'session resume failed',
    );
    expect(grants.revoke).toHaveBeenNthCalledWith(1, 'bridge-token-1');
    expect(grants.revoke).toHaveBeenNthCalledWith(2, 'bridge-token-2');
  });
});
