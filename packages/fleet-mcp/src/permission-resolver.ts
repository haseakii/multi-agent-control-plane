import { isDeepStrictEqual } from 'node:util';
import { BridgeScopeSchema, type BridgeScope } from '@control-plane/core';
import { z } from 'zod';
import { fleetToolDefinitions } from './server.js';
import { fleetToolInputSchemas, isFleetToolName, type FleetToolName } from './tool-input.js';

export const FleetPermissionResolverOptionsSchema = z
  .object({
    serverName: z.string().min(1).max(128),
    scopes: z.array(BridgeScopeSchema),
    projectId: z.string().min(1).max(128),
    taskId: z.string().min(1).max(128),
  })
  .strict();

export type FleetPermissionResolverOptions = {
  /** The exact MCP server name attached by this execution's host. */
  serverName: string;
  /** The scopes actually attached to this execution, not all configured scopes. */
  scopes: readonly BridgeScope[];
  projectId: string;
  taskId: string;
};

export type FleetPermissionRequest = {
  sessionId: string;
  agentInfo: { name: string; version: string } | null;
  toolCall: Readonly<Record<string, unknown>>;
};

export type FleetPermissionMetadataRequest = Omit<FleetPermissionRequest, 'toolCall'> & {
  metadata: unknown;
};

export type FleetPermissionSemantics = {
  tool: string;
  action: string;
  target: string;
  parameters: unknown;
};

const requestSchema = z
  .object({
    sessionId: z.string().min(1),
    agentInfo: z.object({ name: z.string(), version: z.string() }).strict().nullable(),
    toolCall: z.record(z.string(), z.unknown()),
  })
  .strict();
const parametersSchema = z.record(z.string(), z.json());
const metadataRequestSchema = requestSchema
  .omit({ toolCall: true })
  .extend({ metadata: z.unknown() })
  .strict();
const antigravityMetadataSchema = z
  .object({
    mcp: z
      .object({
        tool: z.string().min(1).max(128),
        server: z.string().min(1).max(128),
      })
      .strict(),
    is_mcp_tool_call: z.literal(true),
  })
  .strict();

/** Accept only the observed, non-secret descriptor from this pinned adapter. */
export function createFleetPermissionMetadataValidator(
  options: FleetPermissionResolverOptions,
): (request: FleetPermissionMetadataRequest) => boolean {
  const attached = FleetPermissionResolverOptionsSchema.parse(options);
  return (request) => {
    const parsed = metadataRequestSchema.safeParse(request);
    if (!parsed.success) return false;
    const { agentInfo, metadata } = parsed.data;
    if (agentInfo?.name !== 'antigravity-acp' || agentInfo.version !== '1.4.1') return false;
    const descriptor = antigravityMetadataSchema.safeParse(metadata);
    if (!descriptor.success || descriptor.data.mcp.server !== attached.serverName) return false;
    return fleetToolDefinitions.some(
      (tool) =>
        tool.name === descriptor.data.mcp.tool &&
        tool.anyScope.some((scope) => attached.scopes.includes(scope)),
    );
  };
}

function normalizeInput(rawInput: unknown): Record<string, unknown> | null {
  const parsed = parametersSchema.safeParse(rawInput);
  if (!parsed.success) return null;
  const input = parsed.data;
  if (!Object.hasOwn(input, 'arguments')) return input;
  const args = parametersSchema.safeParse(input.arguments);
  if (!args.success) return null;
  // Antigravity may repeat its arguments beside the wrapper. A mismatch or an
  // unrecognized envelope field must not silently disappear from the review.
  for (const [key, value] of Object.entries(input)) {
    if (key === 'arguments') continue;
    if (!Object.hasOwn(args.data, key) || !isDeepStrictEqual(value, args.data[key])) return null;
  }
  return args.data;
}

function targetFor(
  tool: FleetToolName,
  input: Record<string, unknown>,
  context: { projectId: string; taskId: string },
): string {
  switch (tool) {
    case 'control_get_agent':
      return `agent:${String(input.agentId)}`;
    case 'control_send_message':
      return `agent:${String(input.targetAgentId)}`;
    case 'control_delegate_task':
      return `task:${String(input.taskId)}; agent:${String(input.agentId)}`;
    case 'control_get_task':
    case 'control_wait_task':
    case 'control_cancel_task':
      return `task:${String(input.taskId)}`;
    case 'control_get_artifact':
      return `artifact:${String(input.artifactId)}`;
    case 'control_publish_artifact':
    case 'control_request_approval':
      return `task:${String(input.taskId ?? context.taskId)}`;
    case 'control_discover_agents':
    case 'control_create_task':
    case 'control_search_knowledge':
    case 'control_propose_memory':
      return `project:${context.projectId}`;
  }
}

/**
 * Describe an identified Fleet operation for human ACP permission review.
 * This does not authorize it: the caller retains ACP integrity checks, and
 * Fleet independently enforces current identity, scopes and policy at execution.
 * The host must restrict this callback to the session receiving this attachment.
 */
export function createFleetPermissionResolver(
  options: FleetPermissionResolverOptions,
): (request: FleetPermissionRequest) => FleetPermissionSemantics | null {
  const attached = FleetPermissionResolverOptionsSchema.parse(options);
  const available = fleetToolDefinitions.filter((tool) =>
    tool.anyScope.some((scope) => attached.scopes.includes(scope)),
  );
  const validateMetadata = createFleetPermissionMetadataValidator(attached);
  return (request) => {
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) return null;
    const { toolCall, agentInfo } = parsed.data;
    let identitySource: 'name' | 'antigravity-acp@1.4.1:title' | 'antigravity-acp@1.4.1:metadata';
    let tool;
    if (Object.hasOwn(toolCall, '_meta')) {
      if (
        !validateMetadata({ sessionId: parsed.data.sessionId, agentInfo, metadata: toolCall._meta })
      )
        return null;
      const descriptor = antigravityMetadataSchema.parse(toolCall._meta);
      tool = available.find((candidate) => candidate.name === descriptor.mcp.tool);
      const fullName = `${attached.serverName}_${descriptor.mcp.tool}`;
      if (
        Object.hasOwn(toolCall, 'name') &&
        toolCall.name !== descriptor.mcp.tool &&
        toolCall.name !== fullName
      )
        return null;
      if (Object.hasOwn(toolCall, 'title') && toolCall.title !== fullName) return null;
      identitySource = 'antigravity-acp@1.4.1:metadata';
    } else if (Object.hasOwn(toolCall, 'name')) {
      // An unrecognized explicit name is authoritative; never fall back to title.
      if (typeof toolCall.name !== 'string') return null;
      tool = available.find(
        (candidate) =>
          toolCall.name === candidate.name ||
          toolCall.name === `${attached.serverName}_${candidate.name}`,
      );
      identitySource = 'name';
    } else {
      // Pinned to the observed adapter identity and its complete MCP title format.
      // Generic ACP titles are human descriptions, not reliable tool identifiers.
      if (agentInfo?.name !== 'antigravity-acp' || agentInfo.version !== '1.4.1') return null;
      tool = available.find(
        (candidate) => toolCall.title === `${attached.serverName}_${candidate.name}`,
      );
      identitySource = 'antigravity-acp@1.4.1:title';
    }
    if (!tool || !isFleetToolName(tool.name)) return null;
    const input = normalizeInput(toolCall.rawInput);
    if (!input) return null;
    const validated = fleetToolInputSchemas[tool.name].safeParse(input);
    if (!validated.success) return null;
    const target = targetFor(tool.name, validated.data, attached);
    if (target.length > 1024) return null;
    return {
      tool: tool.name,
      action: tool.operation,
      target,
      parameters: {
        input: validated.data,
        fleet: {
          serverName: attached.serverName,
          projectId: attached.projectId,
          taskId: attached.taskId,
          identitySource,
        },
      },
    };
  };
}
