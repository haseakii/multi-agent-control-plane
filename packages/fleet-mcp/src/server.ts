import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { BridgeScope } from '@control-plane/core';
import type {
  FleetAuditRecord,
  FleetCallContext,
  FleetMcpServerOptions,
  FleetToolDefinition,
} from './types.js';

const bossScope: BridgeScope = 'boss.orchestration';

export const fleetToolDefinitions: readonly FleetToolDefinition[] = [
  { name: 'control_discover_agents', operation: 'agents.discover', anyScope: [bossScope] },
  { name: 'control_get_agent', operation: 'agents.discover', anyScope: [bossScope] },
  { name: 'control_create_task', operation: 'tasks.create', anyScope: [bossScope] },
  { name: 'control_delegate_task', operation: 'tasks.delegate', anyScope: [bossScope] },
  {
    name: 'control_get_task',
    operation: 'tasks.read',
    anyScope: [bossScope, 'task.status'],
  },
  {
    name: 'control_wait_task',
    operation: 'tasks.wait',
    anyScope: [bossScope, 'task.status'],
  },
  { name: 'control_send_message', operation: 'messages.send', anyScope: ['agent.messaging'] },
  {
    name: 'control_publish_artifact',
    operation: 'artifacts.publish',
    anyScope: ['artifact.publish'],
  },
  {
    name: 'control_get_artifact',
    operation: 'artifacts.read',
    anyScope: ['artifact.read'],
  },
  { name: 'control_request_approval', operation: 'approvals.request', anyScope: [bossScope] },
  { name: 'control_cancel_task', operation: 'tasks.cancel', anyScope: [bossScope] },
] as const;

function hasAnyScope(scopes: readonly BridgeScope[], required: readonly BridgeScope[]): boolean {
  return required.some((scope) => scopes.includes(scope));
}

function toolDefinition(name: string): FleetToolDefinition {
  const definition = fleetToolDefinitions.find((candidate) => candidate.name === name);
  if (!definition) {
    throw new TypeError(`Unknown Fleet MCP tool: ${name}`);
  }
  return definition;
}

function ensureBossEligible(options: FleetMcpServerOptions): void {
  const { agent, identity } = options;
  if (agent.id !== identity.agentId) {
    throw new TypeError('Fleet MCP identity must match the configured AgentDefinition.');
  }
  if (!agent.enabled) {
    throw new TypeError('Disabled agents cannot receive the Fleet MCP bridge.');
  }
  if (!agent.orchestration.canBeBoss) {
    throw new TypeError('AgentDefinition is not Boss-capable.');
  }
  if (agent.controlBridge.transport !== 'mcp') {
    throw new TypeError('Boss AgentDefinition must use the MCP control bridge transport.');
  }
  if (!agent.controlBridge.scopes.includes(bossScope)) {
    throw new TypeError('Boss AgentDefinition is missing the boss.orchestration bridge scope.');
  }
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value ?? null),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFleetMcpServer(options: FleetMcpServerOptions): McpServer {
  ensureBossEligible(options);

  const server = new McpServer({
    name: options.name ?? 'multi-agent-control-plane-fleet',
    version: options.version ?? '0.1.0',
  });
  const scopes = options.agent.controlBridge.scopes;

  const invoke = async (
    name: string,
    input: unknown,
    action: (context: FleetCallContext) => Promise<unknown>,
  ) => {
    const definition = toolDefinition(name);
    const context: FleetCallContext = {
      identity: structuredClone(options.identity),
      agent: structuredClone(options.agent),
      toolName: name,
      operation: definition.operation,
    };

    const decision = await options.hooks.authorize({ ...context, input });
    if (!decision.allowed) {
      const record: FleetAuditRecord = {
        ...context,
        input,
        outcome: 'denied',
        reason: decision.reason,
      };
      await options.hooks.audit(record);
      return errorResult(decision.reason);
    }

    try {
      const result = await action(context);
      await options.hooks.audit({ ...context, input, outcome: 'succeeded' });
      return jsonResult(result);
    } catch (error) {
      const reason = errorMessage(error);
      await options.hooks.audit({ ...context, input, outcome: 'failed', reason });
      return errorResult(reason);
    }
  };

  const register = (
    name: string,
    config: Parameters<McpServer['registerTool']>[1],
    handler: Parameters<McpServer['registerTool']>[2],
  ) => {
    const definition = toolDefinition(name);
    if (hasAnyScope(scopes, definition.anyScope)) {
      server.registerTool(name, config, handler);
    }
  };

  register(
    'control_discover_agents',
    {
      description: 'Discover eligible agents by provider-neutral capabilities.',
      inputSchema: z.object({
        exact: z.array(z.string().min(1).max(128)).optional(),
        prefixes: z.array(z.string().min(1).max(128)).optional(),
        custom: z.string().min(1).max(256).optional(),
        limit: z.number().int().positive().max(100).optional(),
      }),
    },
    async (input) =>
      invoke('control_discover_agents', input, (context) =>
        options.services.discoverAgents(input, context),
      ),
  );

  register(
    'control_get_agent',
    {
      description: 'Read one registered agent definition visible to the current Boss.',
      inputSchema: z.object({ agentId: z.string().min(1).max(128) }),
    },
    async (input) =>
      invoke('control_get_agent', input, (context) => options.services.getAgent(input, context)),
  );

  register(
    'control_create_task',
    {
      description: 'Create a durable task in the active project.',
      inputSchema: z.object({
        title: z.string().min(1),
        objective: z.string().min(1),
        parentTaskId: z.string().min(1).optional(),
        dependencyIds: z.array(z.string().min(1)).optional(),
        contextRefs: z.array(z.string().min(1)).optional(),
      }),
    },
    async (input) =>
      invoke('control_create_task', input, (context) => options.services.createTask(input, context)),
  );

  register(
    'control_delegate_task',
    {
      description: 'Delegate a durable task to a selected agent with an optional task-scoped role.',
      inputSchema: z.object({
        taskId: z.string().min(1),
        agentId: z.string().min(1),
        objective: z.string().min(1).optional(),
        role: z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
          })
          .optional(),
      }),
    },
    async (input) =>
      invoke('control_delegate_task', input, (context) =>
        options.services.delegateTask(input, context),
      ),
  );

  register(
    'control_get_task',
    {
      description: 'Read one durable task.',
      inputSchema: z.object({ taskId: z.string().min(1) }),
    },
    async (input) =>
      invoke('control_get_task', input, (context) => options.services.getTask(input, context)),
  );

  register(
    'control_wait_task',
    {
      description: 'Wait for or poll a durable task using the shared task application service.',
      inputSchema: z.object({
        taskId: z.string().min(1),
        timeoutMs: z.number().int().positive().max(300_000).optional(),
      }),
    },
    async (input) =>
      invoke('control_wait_task', input, (context) => options.services.waitTask(input, context)),
  );

  register(
    'control_send_message',
    {
      description: 'Send a control-plane-mediated agent message. Sender identity comes from the bridge.',
      inputSchema: z.object({
        targetAgentId: z.string().min(1),
        taskId: z.string().min(1).optional(),
        type: z.enum(['request', 'response', 'message', 'handoff', 'event', 'status']),
        content: z.string().optional(),
        artifactRefs: z.array(z.string().min(1)).optional(),
      }),
    },
    async (input) =>
      invoke('control_send_message', input, (context) => options.services.sendMessage(input, context)),
  );

  register(
    'control_publish_artifact',
    {
      description: 'Publish an immutable artifact through the shared artifact application service.',
      inputSchema: z.object({
        taskId: z.string().min(1).optional(),
        kind: z.enum([
          'plan',
          'report',
          'patch',
          'diff',
          'log',
          'image',
          'test-report',
          'file',
          'directory-manifest',
          'json',
          'text',
        ]),
        mimeType: z.string().min(1),
        content: z.string().max(1_000_000),
      }),
    },
    async (input) =>
      invoke('control_publish_artifact', input, (context) =>
        options.services.publishArtifact(input, context),
      ),
  );

  register(
    'control_get_artifact',
    {
      description: 'Read artifact metadata/content allowed to the current bridge identity.',
      inputSchema: z.object({ artifactId: z.string().min(1) }),
    },
    async (input) =>
      invoke('control_get_artifact', input, (context) =>
        options.services.getArtifact(input, context),
      ),
  );

  register(
    'control_request_approval',
    {
      description: 'Request a durable approval for a policy-controlled operation.',
      inputSchema: z.object({
        taskId: z.string().min(1).optional(),
        action: z.string().min(1),
        resource: z.record(z.string(), z.unknown()),
      }),
    },
    async (input) =>
      invoke('control_request_approval', input, (context) =>
        options.services.requestApproval(input, context),
      ),
  );

  register(
    'control_cancel_task',
    {
      description: 'Cancel a durable task through the shared task application service.',
      inputSchema: z.object({ taskId: z.string().min(1) }),
    },
    async (input) =>
      invoke('control_cancel_task', input, (context) => options.services.cancelTask(input, context)),
  );

  return server;
}

export async function serveFleetMcpStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
