import type { AgentDefinition, BridgeScope } from '@control-plane/core';
import { fleetToolDefinitions, type FleetBridgeGrantResolver } from '@control-plane/fleet-mcp';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type FleetGatewayIdentity = {
  agentId: AgentDefinition['id'];
  projectId: string;
  sessionId: string;
  taskId?: string | undefined;
};

export type FleetGatewayExecutionRequest = {
  identity: FleetGatewayIdentity;
  agent: AgentDefinition;
  scopes: BridgeScope[];
  toolName: string;
  input: unknown;
};

export type FleetGatewayExecutionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; statusCode?: number | undefined };

export type FleetBridgeGatewayOptions = {
  grants: FleetBridgeGrantResolver;
  getAgent(agentId: AgentDefinition['id']): AgentDefinition | undefined;
  execute(request: FleetGatewayExecutionRequest): Promise<FleetGatewayExecutionResult>;
  auditDenied?(record: {
    reason: string;
    identity?: FleetGatewayIdentity;
    toolName?: string;
  }): Promise<void>;
};

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return undefined;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

async function auditDenial(
  request: FastifyRequest,
  options: FleetBridgeGatewayOptions,
  reason: string,
  grant?: ReturnType<FleetBridgeGrantResolver['resolve']>,
  toolName?: string,
) {
  toolName =
    toolName && fleetToolDefinitions.some((tool) => tool.name === toolName) ? toolName : undefined;
  // Never log bearer tokens or untrusted request bodies. Unknown grants cannot be assigned a project.
  request.log.warn(
    { event: 'fleet.gateway.denied', reason, ...(toolName ? { toolName } : {}) },
    'Fleet gateway rejected a request.',
  );
  await options.auditDenied?.({
    reason,
    ...(grant ? { identity: identityFor(grant) } : {}),
    ...(toolName ? { toolName } : {}),
  });
}

async function authorizeGrant(
  request: FastifyRequest,
  reply: FastifyReply,
  options: FleetBridgeGatewayOptions,
) {
  const token = bearerToken(request);
  if (!token) {
    await auditDenial(request, options, 'authorization_missing');
    void reply.code(401).send({ ok: false, error: 'Bridge authorization required.' });
    return undefined;
  }

  try {
    return options.grants.resolve(token);
  } catch {
    await auditDenial(request, options, 'authorization_invalid');
    void reply.code(401).send({ ok: false, error: 'Bridge authorization failed.' });
    return undefined;
  }
}

function sessionScopedAgent(
  options: FleetBridgeGatewayOptions,
  grant: ReturnType<FleetBridgeGrantResolver['resolve']>,
): AgentDefinition | undefined {
  const agent = options.getAgent(grant.agentId);
  if (
    !agent ||
    !agent.enabled ||
    (grant.scopes.includes('boss.orchestration') && !agent.orchestration.canBeBoss) ||
    agent.controlBridge.transport !== 'mcp'
  ) {
    return undefined;
  }

  const configuredScopes = new Set(agent.controlBridge.scopes);
  if (grant.scopes.some((scope) => !configuredScopes.has(scope))) {
    return undefined;
  }

  return {
    ...structuredClone(agent),
    controlBridge: {
      transport: 'mcp',
      scopes: [...grant.scopes],
    },
  };
}

function identityFor(grant: ReturnType<FleetBridgeGrantResolver['resolve']>): FleetGatewayIdentity {
  return {
    agentId: grant.agentId,
    projectId: grant.projectId,
    sessionId: grant.sessionId ?? 'pending',
    ...(grant.taskId === undefined ? {} : { taskId: grant.taskId }),
  };
}

export function registerFleetBridgeGateway(
  app: FastifyInstance,
  options: FleetBridgeGatewayOptions,
): void {
  app.get('/internal/fleet/manifest', async (request, reply) => {
    const grant = await authorizeGrant(request, reply, options);
    if (!grant) {
      return reply;
    }

    const agent = sessionScopedAgent(options, grant);
    if (!agent) {
      await auditDenial(request, options, 'scope_ineligible', grant);
      return reply.code(403).send({ ok: false, error: 'Bridge scope is not eligible.' });
    }

    return {
      identity: identityFor(grant),
      agent,
    };
  });

  app.post('/internal/fleet/tool', async (request, reply) => {
    const grant = await authorizeGrant(request, reply, options);
    if (!grant) {
      return reply;
    }
    if (!grant.sessionId) {
      await auditDenial(request, options, 'session_unbound', grant);
      return reply.code(409).send({
        ok: false,
        error: 'Bridge grant is not bound to an ACP session yet.',
      });
    }

    const agent = sessionScopedAgent(options, grant);
    if (!agent) {
      await auditDenial(request, options, 'scope_ineligible', grant);
      return reply.code(403).send({ ok: false, error: 'Bridge scope is not eligible.' });
    }

    const body = request.body as { toolName?: unknown; input?: unknown } | undefined;
    if (!body || typeof body.toolName !== 'string' || body.toolName.length === 0) {
      await auditDenial(request, options, 'request_invalid', grant);
      return reply.code(400).send({ ok: false, error: 'toolName is required.' });
    }

    try {
      const result = await options.execute({
        identity: identityFor(grant),
        agent,
        scopes: [...grant.scopes],
        toolName: body.toolName,
        input: body.input,
      });
      if (!result.ok) {
        await auditDenial(request, options, 'tool_rejected', grant, body.toolName);
        return reply.code(result.statusCode ?? 403).send(result);
      }
      return result;
    } catch {
      return reply.code(500).send({
        ok: false,
        error: 'Fleet bridge tool execution failed.',
      });
    }
  });
}
