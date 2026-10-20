import type { AgentDefinition } from '@control-plane/core';
import {
  createFleetToolExecutor,
  type FleetBridgeGrantResolver,
  type FleetBridgeHooks,
  type FleetControlServices,
} from '@control-plane/fleet-mcp';
import type { FleetBridgeGatewayOptions } from './fleet-gateway.js';

export type FleetGatewayCompositionOptions = {
  grants: FleetBridgeGrantResolver;
  getAgent(agentId: AgentDefinition['id']): AgentDefinition | undefined;
  services: FleetControlServices;
  hooks: FleetBridgeHooks;
};

export function createFleetGatewayOptions(
  options: FleetGatewayCompositionOptions,
): FleetBridgeGatewayOptions {
  const executeTool = createFleetToolExecutor({
    services: options.services,
    hooks: options.hooks,
  });

  return {
    grants: options.grants,
    getAgent: options.getAgent,
    execute: async (request) =>
      executeTool({
        identity: request.identity,
        agent: request.agent,
        toolName: request.toolName,
        input: request.input,
      }),
  };
}
