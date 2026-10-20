import Fastify, { type FastifyServerOptions } from 'fastify';
import type { ControlCenterSnapshot } from './control-center.js';
import { registerAgentControlRoutes, type AgentControlService } from './agent-control.js';
import { registerFleetBridgeGateway, type FleetBridgeGatewayOptions } from './fleet-gateway.js';

export type ControlCenterProvider = () => Promise<ControlCenterSnapshot> | ControlCenterSnapshot;

export type BuildServerOptions = {
  fastify?: FastifyServerOptions;
  controlCenter?: ControlCenterProvider;
  fleetGateway?: FleetBridgeGatewayOptions;
  agentControl?: AgentControlService;
};

export function buildServer(options: BuildServerOptions = {}) {
  const app = Fastify(options.fastify ?? {});

  if (options.fleetGateway) {
    registerFleetBridgeGateway(app, options.fleetGateway);
  }
  if (options.agentControl) {
    registerAgentControlRoutes(app, options.agentControl);
  }

  app.get('/health', async () => ({
    status: 'ok' as const,
    service: 'multi-agent-control-plane',
  }));

  app.get('/api/control-center', async () => {
    if (!options.controlCenter) {
      return {
        generatedAt: new Date().toISOString(),
        projects: [],
        agents: [],
        tasks: [],
        assignments: [],
        timeline: [],
        messages: [],
        approvals: [],
        artifacts: [],
        runners: [],
        workspaces: [],
      } satisfies ControlCenterSnapshot;
    }
    return options.controlCenter();
  });

  return app;
}
