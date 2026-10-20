import { resolve } from 'node:path';
import { AgentDefinitionSchema } from '@control-plane/core';
import { describe, expect, it, vi } from 'vitest';
import { FleetBossSessionAttachment } from './session-attachment.js';
import type {
  FleetBossSessionContext,
  FleetBridgeGrantIssuer,
  FleetSessionRuntime,
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
});
