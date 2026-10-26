import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@agentclientprotocol/sdk';
import type { AgentDefinition, AgentId, BridgeScope } from '@control-plane/core';

export type FleetBridgeGrantRequest = {
  agentId: AgentId;
  projectId: string;
  taskId?: string | undefined;
  scopes: BridgeScope[];
  sessionId?: string | undefined;
};

export type FleetBridgeGrant = {
  token: string;
  expiresAt: string;
};

export interface FleetBridgeGrantIssuer {
  issue(request: FleetBridgeGrantRequest): Promise<FleetBridgeGrant>;
  bindSession(token: string, sessionId: string): Promise<void>;
  revoke(token: string): Promise<void>;
}

export type FleetMcpLaunchConfig = {
  command: string;
  args?: string[] | undefined;
  environment?: Record<string, string> | undefined;
  serverName?: string | undefined;
};

export function getFleetMcpStdioProxyPath(): string {
  return fileURLToPath(new URL('./stdio-proxy-main.js', import.meta.url));
}

export type FleetSessionContext = {
  agent: AgentDefinition;
  projectId: string;
  taskId?: string | undefined;
  scopes: BridgeScope[];
  cwd: string;
};

export type FleetBossSessionContext = FleetSessionContext;

export type FleetSessionRef = {
  sessionId: string;
};

export interface FleetSessionRuntime {
  newSession(input: {
    cwd: string;
    mcpServers?: McpServer[] | undefined;
  }): Promise<FleetSessionRef>;
  resumeSession(
    sessionId: string,
    input: { cwd: string; mcpServers?: McpServer[] | undefined },
  ): Promise<FleetSessionRef>;
}

export type FleetAttachedSession = {
  session: FleetSessionRef;
  bridgeGrantExpiresAt: string;
};

function validateContext(context: FleetSessionContext): void {
  const { agent, scopes } = context;

  if (!agent.enabled) {
    throw new TypeError('Disabled agents cannot receive a Fleet MCP attachment.');
  }
  if (scopes.includes('boss.orchestration') && !agent.orchestration.canBeBoss) {
    throw new TypeError('AgentDefinition is not Boss-capable.');
  }
  if (agent.controlBridge.transport !== 'mcp') {
    throw new TypeError('AgentDefinition must use the MCP control bridge transport.');
  }

  const configured = new Set(agent.controlBridge.scopes);
  for (const scope of scopes) {
    if (!configured.has(scope)) {
      throw new TypeError(`Requested Fleet MCP scope is outside the configured ceiling: ${scope}`);
    }
  }
}

function validateLaunch(launch: FleetMcpLaunchConfig): void {
  if (!isAbsolute(launch.command)) {
    throw new TypeError('Fleet MCP stdio command must be an absolute path for ACP session setup.');
  }
}

function grantRequest(context: FleetSessionContext, sessionId?: string): FleetBridgeGrantRequest {
  return {
    agentId: context.agent.id,
    projectId: context.projectId,
    scopes: [...context.scopes],
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function mcpServerConfig(launch: FleetMcpLaunchConfig, grant: FleetBridgeGrant): McpServer {
  const env = Object.entries({
    ...(launch.environment ?? {}),
    CONTROL_PLANE_BRIDGE_GRANT: grant.token,
  }).map(([name, value]) => ({ name, value }));

  return {
    name: launch.serverName ?? 'control-plane-fleet',
    command: launch.command,
    args: [...(launch.args ?? [])],
    env,
  } as McpServer;
}

export class FleetSessionAttachment {
  constructor(
    private readonly runtime: FleetSessionRuntime,
    private readonly grantIssuer: FleetBridgeGrantIssuer,
    private readonly launch: FleetMcpLaunchConfig,
  ) {
    validateLaunch(launch);
  }

  protected validateContext(context: FleetSessionContext): void {
    validateContext(context);
  }

  async create(context: FleetSessionContext): Promise<FleetAttachedSession> {
    this.validateContext(context);
    const grant = await this.grantIssuer.issue(grantRequest(context));

    try {
      const session = await this.runtime.newSession({
        cwd: context.cwd,
        mcpServers: [mcpServerConfig(this.launch, grant)],
      });
      await this.grantIssuer.bindSession(grant.token, session.sessionId);
      return {
        session,
        bridgeGrantExpiresAt: grant.expiresAt,
      };
    } catch (error) {
      await this.grantIssuer.revoke(grant.token);
      throw error;
    }
  }

  async resume(sessionId: string, context: FleetSessionContext): Promise<FleetAttachedSession> {
    this.validateContext(context);
    const grant = await this.grantIssuer.issue(grantRequest(context, sessionId));

    try {
      const session = await this.runtime.resumeSession(sessionId, {
        cwd: context.cwd,
        mcpServers: [mcpServerConfig(this.launch, grant)],
      });
      return {
        session,
        bridgeGrantExpiresAt: grant.expiresAt,
      };
    } catch (error) {
      await this.grantIssuer.revoke(grant.token);
      throw error;
    }
  }
}

export class FleetBossSessionAttachment extends FleetSessionAttachment {
  protected override validateContext(context: FleetBossSessionContext): void {
    super.validateContext(context);
    if (!context.agent.orchestration.canBeBoss) {
      throw new TypeError('AgentDefinition is not Boss-capable.');
    }
    if (!context.scopes.includes('boss.orchestration')) {
      throw new TypeError('Boss session scopes must include boss.orchestration.');
    }
  }
}
