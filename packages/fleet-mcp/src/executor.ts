import { z } from 'zod';
import type { BridgeScope } from '@control-plane/core';
import { fleetToolDefinitions } from './server.js';
import type {
  FleetAuditRecord,
  FleetBridgeHooks,
  FleetCallContext,
  FleetControlServices,
  FleetMcpServerOptions,
} from './types.js';

export type FleetToolExecutionRequest = Pick<FleetMcpServerOptions, 'identity' | 'agent'> & {
  toolName: string;
  input: unknown;
};

export type FleetToolExecutionResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string; statusCode: number };

const schemas = {
  control_discover_agents: z
    .object({
      exact: z.array(z.string().min(1).max(128)).optional(),
      prefixes: z.array(z.string().min(1).max(128)).optional(),
      custom: z.string().min(1).max(256).optional(),
      limit: z.number().int().positive().max(100).optional(),
    })
    .strict(),
  control_get_agent: z.object({ agentId: z.string().min(1).max(128) }).strict(),
  control_create_task: z
    .object({
      title: z.string().min(1),
      objective: z.string().min(1),
      parentTaskId: z.string().min(1).optional(),
      dependencyIds: z.array(z.string().min(1)).optional(),
      contextRefs: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  control_delegate_task: z
    .object({
      taskId: z.string().min(1),
      agentId: z.string().min(1),
      objective: z.string().min(1).optional(),
      role: z
        .object({
          name: z.string().min(1),
          description: z.string().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  control_get_task: z.object({ taskId: z.string().min(1) }).strict(),
  control_wait_task: z
    .object({
      taskId: z.string().min(1),
      timeoutMs: z.number().int().positive().max(300_000).optional(),
    })
    .strict(),
  control_send_message: z
    .object({
      targetAgentId: z.string().min(1),
      taskId: z.string().min(1).optional(),
      type: z.enum(['request', 'response', 'message', 'handoff', 'event', 'status']),
      content: z.string().optional(),
      artifactRefs: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  control_publish_artifact: z
    .object({
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
    })
    .strict(),
  control_get_artifact: z.object({ artifactId: z.string().min(1) }).strict(),
  control_request_approval: z
    .object({
      taskId: z.string().min(1).optional(),
      action: z.string().min(1),
      resource: z.record(z.string(), z.unknown()),
    })
    .strict(),
  control_cancel_task: z.object({ taskId: z.string().min(1) }).strict(),
} as const;

type FleetToolName = keyof typeof schemas;

function isToolName(name: string): name is FleetToolName {
  return Object.prototype.hasOwnProperty.call(schemas, name);
}

function toolDefinition(name: FleetToolName) {
  const definition = fleetToolDefinitions.find((candidate) => candidate.name === name);
  if (!definition) {
    throw new TypeError(`Unknown Fleet tool definition: ${name}`);
  }
  return definition;
}

function hasAnyScope(scopes: readonly BridgeScope[], required: readonly BridgeScope[]): boolean {
  return required.some((scope) => scopes.includes(scope));
}

function validateExecutionIdentity(
  request: FleetToolExecutionRequest,
): FleetToolExecutionResult | undefined {
  const { identity, agent } = request;
  if (identity.agentId !== agent.id) {
    return { ok: false, error: 'Fleet bridge identity mismatch.', statusCode: 403 };
  }
  if (!agent.enabled || !agent.orchestration.canBeBoss || agent.controlBridge.transport !== 'mcp') {
    return { ok: false, error: 'Fleet bridge agent is not eligible.', statusCode: 403 };
  }
  return undefined;
}

function auditInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }

  const source = input as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  const allowedKeys = new Set([
    'agentId',
    'targetAgentId',
    'taskId',
    'parentTaskId',
    'artifactId',
    'kind',
    'mimeType',
    'type',
    'limit',
    'timeoutMs',
    'dependencyIds',
    'contextRefs',
    'artifactRefs',
  ]);

  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (lower.includes('secret') || lower.includes('token') || lower.includes('password')) {
      safe[`${key}Omitted`] = true;
      continue;
    }
    if (key === 'content') {
      safe.contentBytes = new TextEncoder().encode(String(value ?? '')).length;
      continue;
    }
    if (key === 'resource') {
      safe.resourceOmitted = true;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        safe.resourceKeys = Object.keys(value as Record<string, unknown>).sort();
      }
      continue;
    }
    if (key === 'custom') {
      safe.customQueryProvided = typeof value === 'string' && value.length > 0;
      continue;
    }
    if (allowedKeys.has(key)) {
      safe[key] = structuredClone(value);
    }
  }

  return safe;
}

async function dispatch(
  name: FleetToolName,
  input: z.infer<(typeof schemas)[FleetToolName]>,
  services: FleetControlServices,
  context: FleetCallContext,
): Promise<unknown> {
  switch (name) {
    case 'control_discover_agents':
      return services.discoverAgents(schemas.control_discover_agents.parse(input), context);
    case 'control_get_agent':
      return services.getAgent(schemas.control_get_agent.parse(input), context);
    case 'control_create_task':
      return services.createTask(schemas.control_create_task.parse(input), context);
    case 'control_delegate_task':
      return services.delegateTask(schemas.control_delegate_task.parse(input), context);
    case 'control_get_task':
      return services.getTask(schemas.control_get_task.parse(input), context);
    case 'control_wait_task':
      return services.waitTask(schemas.control_wait_task.parse(input), context);
    case 'control_send_message':
      return services.sendMessage(schemas.control_send_message.parse(input), context);
    case 'control_publish_artifact':
      return services.publishArtifact(schemas.control_publish_artifact.parse(input), context);
    case 'control_get_artifact':
      return services.getArtifact(schemas.control_get_artifact.parse(input), context);
    case 'control_request_approval':
      return services.requestApproval(schemas.control_request_approval.parse(input), context);
    case 'control_cancel_task':
      return services.cancelTask(schemas.control_cancel_task.parse(input), context);
  }
}

export type FleetToolExecutorOptions = {
  services: FleetControlServices;
  hooks: FleetBridgeHooks;
};

export function createFleetToolExecutor(options: FleetToolExecutorOptions) {
  return async (request: FleetToolExecutionRequest): Promise<FleetToolExecutionResult> => {
    const identityError = validateExecutionIdentity(request);
    if (identityError) {
      return identityError;
    }

    if (!isToolName(request.toolName)) {
      return { ok: false, error: 'Unknown Fleet tool.', statusCode: 404 };
    }

    const definition = toolDefinition(request.toolName);
    if (!hasAnyScope(request.agent.controlBridge.scopes, definition.anyScope)) {
      return { ok: false, error: 'Fleet tool scope denied.', statusCode: 403 };
    }

    const parsed = schemas[request.toolName].safeParse(request.input);
    if (!parsed.success) {
      return { ok: false, error: 'Fleet tool input is invalid.', statusCode: 400 };
    }

    const context: FleetCallContext = {
      identity: structuredClone(request.identity),
      agent: structuredClone(request.agent),
      toolName: request.toolName,
      operation: definition.operation,
    };
    const safeInput = auditInput(parsed.data);

    let decision;
    try {
      decision = await options.hooks.authorize({ ...context, input: parsed.data });
    } catch {
      await options.hooks.audit({
        ...context,
        input: safeInput,
        outcome: 'denied',
        reason: 'policy_evaluation_failed',
      });
      return { ok: false, error: 'Policy evaluation failed.', statusCode: 403 };
    }

    if (!decision.allowed) {
      const record: FleetAuditRecord = {
        ...context,
        input: safeInput,
        outcome: 'denied',
        reason: 'policy_denied',
      };
      await options.hooks.audit(record);
      return { ok: false, error: 'Fleet tool policy denied.', statusCode: 403 };
    }

    try {
      const result = await dispatch(request.toolName, parsed.data, options.services, context);
      await options.hooks.audit({ ...context, input: safeInput, outcome: 'succeeded' });
      return { ok: true, result };
    } catch {
      await options.hooks.audit({
        ...context,
        input: safeInput,
        outcome: 'failed',
        reason: 'service_error',
      });
      return { ok: false, error: 'Fleet tool service failed.', statusCode: 500 };
    }
  };
}
