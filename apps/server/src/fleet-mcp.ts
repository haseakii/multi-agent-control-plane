import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  AgentDefinitionSchema,
  type AgentDefinition,
  type BridgeScope,
  type JsonValue,
} from '@control-plane/core';
import { z } from 'zod';

export type FleetMcpPrincipal = {
  agentId: string;
  projectId: string;
  sessionId: string;
  activeTaskId?: string;
  scopes: BridgeScope[];
};

export type FleetMcpReadiness = {
  runtime: 'unknown' | 'ready' | 'error';
  auth: 'unknown' | 'needs_login' | 'ready' | 'not_reported';
};

export type FleetMcpAuditEvent = {
  operation: string;
  principal: FleetMcpPrincipal;
  resource: Record<string, JsonValue>;
  phase: 'denied' | 'attempted' | 'completed' | 'failed';
  reason?: string;
};

export type FleetMcpServices = {
  agents: {
    discover(input: {
      exact?: string[] | undefined;
      prefixes?: string[] | undefined;
      custom?: string | undefined;
      limit?: number | undefined;
    }, principal: FleetMcpPrincipal): Promise<unknown>;
    get(input: { agentId: string }, principal: FleetMcpPrincipal): Promise<unknown>;
  };
  tasks: {
    create(input: { title: string; objective: string; parentTaskId?: string | undefined }, principal: FleetMcpPrincipal): Promise<unknown>;
    delegate(input: { taskId: string; agentId: string; objective: string; role?: { name: string; description?: string | undefined } | undefined }, principal: FleetMcpPrincipal): Promise<unknown>;
    get(input: { taskId: string }, principal: FleetMcpPrincipal): Promise<unknown>;
    wait(input: { taskId: string; timeoutMs?: number | undefined }, principal: FleetMcpPrincipal): Promise<unknown>;
    cancel(input: { taskId: string; cascade?: boolean | undefined }, principal: FleetMcpPrincipal): Promise<unknown>;
  };
  messages: {
    send(input: { taskId: string; toAgentId?: string | undefined; type: 'request' | 'response' | 'message' | 'handoff' | 'event' | 'status'; content?: string | undefined; artifactRefs?: string[] | undefined; correlationId?: string }, principal: FleetMcpPrincipal): Promise<unknown>;
  };
  artifacts: {
    publish(input: { taskId?: string | undefined; kind: 'plan' | 'report' | 'patch' | 'diff' | 'log' | 'image' | 'test-report' | 'file' | 'directory-manifest' | 'json' | 'text'; mimeType: string; content: string }, principal: FleetMcpPrincipal): Promise<unknown>;
    get(input: { artifactId: string }, principal: FleetMcpPrincipal): Promise<unknown>;
  };
  approvals: {
    request(input: { taskId?: string | undefined; action: string; resource: JsonValue }, principal: FleetMcpPrincipal): Promise<unknown>;
  };
  policy: {
    authorize(input: { operation: string; principal: FleetMcpPrincipal; resource: Record<string, JsonValue> }): Promise<{ allowed: boolean; reason?: string }>;
  };
  audit: {
    record(event: FleetMcpAuditEvent): Promise<void>;
  };
};

type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  scopes: BridgeScope[];
  scopeMode?: 'all' | 'any';
  resource: (input: Record<string, unknown>) => Record<string, JsonValue>;
  invoke: (input: never, principal: FleetMcpPrincipal, services: FleetMcpServices) => Promise<unknown>;
};

const emptyObject = z.object({}).strict();
const taskId = z.string().trim().min(1).max(128);
const agentId = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(20_000);
const jsonResource = z.json();

function safeResource(input: Record<string, unknown>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (['content', 'resource', 'secret', 'token', 'password'].includes(key.toLowerCase())) {
      result[`${key}Omitted`] = true;
      continue;
    }
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    ) {
      result[key] = value as JsonValue;
    }
  }
  return result;
}

function hasRequiredScopes(principal: FleetMcpPrincipal, tool: ToolDefinition): boolean {
  return tool.scopeMode === 'any'
    ? tool.scopes.some((scope) => principal.scopes.includes(scope))
    : tool.scopes.every((scope) => principal.scopes.includes(scope));
}

function defineTool<TSchema extends z.ZodObject<z.ZodRawShape>>(
  definition: Omit<ToolDefinition, 'schema' | 'invoke'> & {
    schema: TSchema;
    invoke: (input: z.infer<TSchema>, principal: FleetMcpPrincipal, services: FleetMcpServices) => Promise<unknown>;
  },
): ToolDefinition {
  return definition as ToolDefinition;
}

const tools: ToolDefinition[] = [
  defineTool({
    name: 'control_discover_agents',
    description: 'Discover enabled, ready agents by exact capabilities, prefixes, or a registered custom query. Capabilities are routing hints, not permissions.',
    schema: z.object({
      exact: z.array(z.string().trim().min(1).max(128)).optional(),
      prefixes: z.array(z.string().trim().min(1).max(128)).optional(),
      custom: z.string().trim().min(1).max(256).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }).strict(),
    scopes: ['boss.orchestration'],
    resource: safeResource,
    invoke: (input, principal, services) => services.agents.discover(input, principal),
  }),
  defineTool({
    name: 'control_get_agent',
    description: 'Read an agent definition visible to the active project.',
    schema: z.object({ agentId }).strict(),
    scopes: ['boss.orchestration'],
    resource: safeResource,
    invoke: (input, principal, services) => services.agents.get(input, principal),
  }),
  defineTool({
    name: 'control_create_task',
    description: 'Create a task in the authenticated session project.',
    schema: z.object({ title: text, objective: text, parentTaskId: taskId.optional() }).strict(),
    scopes: ['boss.orchestration'],
    resource: safeResource,
    invoke: (input, principal, services) => services.tasks.create(input, principal),
  }),
  defineTool({
    name: 'control_delegate_task',
    description: 'Delegate an existing task to an eligible agent with a task-scoped role.',
    schema: z.object({
      taskId,
      agentId,
      objective: text,
      role: z.object({ name: text, description: text.optional() }).strict().optional(),
    }).strict(),
    scopes: ['boss.orchestration'],
    resource: safeResource,
    invoke: (input, principal, services) => services.tasks.delegate(input, principal),
  }),
  defineTool({
    name: 'control_get_task',
    description: 'Read task status within the authenticated project/task scope.',
    schema: z.object({ taskId }).strict(),
    scopes: ['boss.orchestration', 'task.status'],
    scopeMode: 'any',
    resource: safeResource,
    invoke: (input, principal, services) => services.tasks.get(input, principal),
  }),
  defineTool({
    name: 'control_wait_task',
    description: 'Wait for task state changes up to a bounded timeout.',
    schema: z.object({ taskId, timeoutMs: z.number().int().min(0).max(120_000).optional() }).strict(),
    scopes: ['boss.orchestration'],
    resource: safeResource,
    invoke: (input, principal, services) => services.tasks.wait(input, principal),
  }),
  defineTool({
    name: 'control_send_message',
    description: 'Send a durable message through the control-plane message router.',
    schema: z.object({
      taskId,
      toAgentId: agentId.optional(),
      type: z.enum(['request', 'response', 'message', 'handoff', 'event', 'status']),
      content: z.string().max(20_000).optional(),
      artifactRefs: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
      correlationId: z.string().trim().min(1).max(128).optional(),
    }).strict(),
    scopes: ['agent.messaging'],
    resource: safeResource,
    invoke: (input, principal, services) => services.messages.send(input, principal),
  }),
  defineTool({
    name: 'control_publish_artifact',
    description: 'Publish an immutable artifact through the shared artifact service.',
    schema: z.object({
      taskId: taskId.optional(),
      kind: z.enum(['plan', 'report', 'patch', 'diff', 'log', 'image', 'test-report', 'file', 'directory-manifest', 'json', 'text']),
      mimeType: z.string().trim().min(1).max(256),
      content: z.string().max(1_000_000),
    }).strict(),
    scopes: ['artifact.publish'],
    resource: (input) => ({
      ...safeResource(input),
      contentBytes: new TextEncoder().encode(String(input.content ?? '')).length,
    }),
    invoke: (input, principal, services) => services.artifacts.publish(input, principal),
  }),
  defineTool({
    name: 'control_get_artifact',
    description: 'Read an artifact only when permitted by the active scope and policy.',
    schema: z.object({ artifactId: z.string().trim().min(1).max(128) }).strict(),
    scopes: ['artifact.read'],
    resource: safeResource,
    invoke: (input, principal, services) => services.artifacts.get(input, principal),
  }),
  defineTool({
    name: 'control_request_approval',
    description: 'Request a durable approval for a mediated operation.',
    schema: z.object({ taskId: taskId.optional(), action: text, resource: jsonResource }).strict(),
    scopes: ['boss.orchestration'],
    resource: (input) => ({
      ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}),
      action: String(input.action),
      resourceKeys: Object.keys((input.resource ?? {}) as Record<string, unknown>),
    }),
    invoke: (input, principal, services) => services.approvals.request(input, principal),
  }),
  defineTool({
    name: 'control_cancel_task',
    description: 'Cancel a task; cascading to children is explicit and policy checked.',
    schema: z.object({ taskId, cascade: z.boolean().optional() }).strict(),
    scopes: ['boss.orchestration'],
    resource: safeResource,
    invoke: (input, principal, services) => services.tasks.cancel(input, principal),
  }),
];

export class FleetMcpBridge {
  readonly principal: FleetMcpPrincipal;
  private readonly exposedTools: ToolDefinition[];

  constructor(
    agentInput: AgentDefinition,
    principalInput: FleetMcpPrincipal,
    options: {
      readiness: FleetMcpReadiness;
      supportsSessionMcp: boolean;
      bossAssignmentAllowed: boolean;
    },
    private readonly services: FleetMcpServices,
  ) {
    const agent = AgentDefinitionSchema.parse(agentInput);
    if (!agent.enabled) {
      throw new Error('Cannot attach the control bridge to a disabled agent.');
    }
    if (agent.controlBridge.transport !== 'mcp') {
      throw new Error('Agent is not configured to use the MCP control bridge.');
    }
    if (!options.supportsSessionMcp) {
      throw new Error('The ACP runtime does not support session-level MCP attachment.');
    }
    if (
      options.readiness.runtime !== 'ready' ||
      !['ready', 'not_reported'].includes(options.readiness.auth)
    ) {
      throw new Error('Agent runtime/auth readiness is insufficient for MCP bridge attachment.');
    }

    const principal: FleetMcpPrincipal = {
      ...principalInput,
      scopes: [...new Set(principalInput.scopes)],
    };
    if (principal.agentId !== agent.id) {
      throw new Error('Authenticated principal does not match the attached agent.');
    }
    if (principal.scopes.some((scope) => !agent.controlBridge.scopes.includes(scope))) {
      throw new Error('Session scopes exceed the configured control bridge scope ceiling.');
    }
    if (
      principal.scopes.includes('boss.orchestration') &&
      (!agent.orchestration.canBeBoss || !options.bossAssignmentAllowed)
    ) {
      throw new Error('Agent is not eligible for Boss orchestration in this project.');
    }

    this.principal = Object.freeze({
      ...principal,
      scopes: Object.freeze([...principal.scopes]) as unknown as BridgeScope[],
    });
    this.exposedTools = tools.filter((tool) => hasRequiredScopes(this.principal, tool));
  }

  listTools(): Array<{ name: string; description: string; scopes: BridgeScope[] }> {
    return this.exposedTools.map(({ name, description, scopes }) => ({
      name,
      description,
      scopes: [...scopes],
    }));
  }

  async call(name: string, input: unknown): Promise<unknown> {
    const tool = this.exposedTools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Tool is not available in this session: ${name}`);
    }

    const args = tool.schema.parse(input) as Record<string, unknown>;
    const resource = tool.resource(args);
    const decision = await this.services.policy.authorize({
      operation: tool.name,
      principal: this.principal,
      resource,
    });

    if (!decision.allowed) {
      await this.services.audit.record({
        operation: tool.name,
        principal: this.principal,
        resource,
        phase: 'denied',
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      throw new Error(decision.reason ?? `Policy denied operation: ${tool.name}`);
    }

    await this.services.audit.record({
      operation: tool.name,
      principal: this.principal,
      resource,
      phase: 'attempted',
    });

    try {
      const result = await tool.invoke(args as never, this.principal, this.services);
      await this.services.audit.record({
        operation: tool.name,
        principal: this.principal,
        resource,
        phase: 'completed',
      });
      return result;
    } catch (error) {
      await this.services.audit.record({
        operation: tool.name,
        principal: this.principal,
        resource,
        phase: 'failed',
        reason: error instanceof Error ? error.message : 'Unknown service failure',
      });
      throw error;
    }
  }
}

export function createFleetMcpServer(bridge: FleetMcpBridge): McpServer {
  const server = new McpServer({
    name: 'multi-agent-control-plane-fleet-bridge',
    version: '0.1.0',
  });

  for (const tool of bridge.listTools()) {
    const definition = tools.find((candidate) => candidate.name === tool.name);
    if (!definition) {
      continue;
    }
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.schema,
      },
      async (input) => {
        const result = await bridge.call(definition.name, input);
        return {
          content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
        };
      },
    );
  }

  return server;
}

export async function connectFleetMcpStdio(bridge: FleetMcpBridge): Promise<McpServer> {
  const server = createFleetMcpServer(bridge);
  await server.connect(new StdioServerTransport());
  return server;
}
